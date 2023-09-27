const minimist = require("minimist");
const fs = require("fs-extra");
const path = require("path");
const semver = require('semver');

//
// Reads the dependencies that are installed in a particular directory.
//
async function readInstalledDependencies(dir, options) {
    if (!await fs.pathExists(dir)) {
        // Nothing to see here.
        return [];
    }

    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) {
        // It's not actually a subdirectory.
        return [];
    }

    const subDirs = await fs.readdir(dir);
    const promises = Promise.all(
        subDirs
            .filter(subDir => subDir !== ".bin")
            .map(async subDir => {
                const subDirPath = path.join(dir, subDir);
                const packageJsonPath = path.join(subDirPath, "package.json");
                if (await fs.pathExists(packageJsonPath)) {
                    return [await buildDependencyTree(subDirPath, options)];
                }
                else {
                    return await readInstalledDependencies(subDirPath, options);
                }
            })
    );

    const dependencies = await promises;
    return dependencies.flat();
}

//
// Builds the dependency tree for a module.
//
async function buildDependencyTree(dir, options) {

    // Loads the package file.
    const packageJsonPath = path.join(dir, "package.json");
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));

    // Determine dependencies in node_modules.
    const nodeModulesPath = path.join(dir, "node_modules");
    const installedDependencies = {};
    const dependencies = await readInstalledDependencies(nodeModulesPath, options);
    for (const dependency of dependencies) {
        installedDependencies[dependency.name] = dependency;
    }

    let wantDependencies = packageJson.dependencies || {};
    if (options?.devDependencies) {
        wantDependencies = Object.assign({}, wantDependencies, packageJson.devDependencies || {});
    }

    return {
        name: packageJson.name,
        version: packageJson.version,
        dir: dir,
        wantDependencies,
        installedDependencies,
    };
}

//
// Recursively copy all files from one directory to another.
//
async function copyDir(srcDir, destDir) {

    await fs.ensureDir(destDir);

    const entries = await fs.readdir(srcDir, { withFileTypes: true });

    await Promise.all(entries
        .filter(entry => entry.name !== "node_modules")
        .map(async entry => {
            const srcPath = path.join(srcDir, entry.name);
            const destPath = path.join(destDir, entry.name);
            if (entry.isDirectory()) {
                await copyDir(srcPath, destPath);
            } 
            else {
                await fs.copy(srcPath, destPath);
            }
        })
    );
}

//
// Finds the pnpm directory, if it exists.
//
async function findPnpmDir(dir) {
    const pnpmDir = path.join(dir, "node_modules", ".pnpm");
    if (await fs.pathExists(pnpmDir)) {
        return pnpmDir;
    }
    const parentDir = path.dirname(dir);
    if (parentDir === dir) {
        return undefined;
    }
    return findPnpmDir(parentDir);
}

//
// Compare modules by semantic version numbers.
//
function compareVersionsDescending(a, b) {
    const partsA = a.version.split('.').map(Number);
    const partsB = b.version.split('.').map(Number);

    for (let i = 0; i < partsA.length; i++) {
        if (partsA[i] > partsB[i]) {
            return -1; // Swap this with the original
        }
        if (partsA[i] < partsB[i]) {
            return 1; // Swap this with the original
        }
    }
    return 0;
}

//
// Copies one dependency to the target directory.
//
async function _copyDependency(module, requiredVersion, requiredBy, targetDir, pnpmCacheDir, cachedModuleMap, copyMap, depStack) {
    const targetModuleDir = path.join(targetDir, module.name);
    const existingCopy = copyMap[module.name];
    if (existingCopy) {
        if (semver.satisfies(existingCopy.version, requiredVersion)) {
            //
            // Already have copied a version that satisfies our requirements.
            //
            // console.log(`Already have a copy of ${existingCopy.name}@${existingCopy.version} that satisfies ${module.name}:${requiredVersion} required by ${requiredBy.name}`);
            return 0; 
        }

        //
        // Otherwise install the required version where it is needed.
        //
        const targetModuleVersionDir = path.join(requiredBy.targetDir, "node_modules", module.name);
        await copyDir(module.dir, targetModuleVersionDir);
        module.targetDir = targetModuleVersionDir;
    }
    else {
        await copyDir(module.dir, targetModuleDir);
        copyMap[module.name] = module;
        module.targetDir = targetModuleDir;
    }

    const numDependencies = await copyDependencies(module, targetDir, pnpmCacheDir, cachedModuleMap, copyMap, depStack);
    return 1 + numDependencies;
} 

//
// Copies a dependency to the target directory.
//
async function copyDependency(depTree, moduleName, requiredVersion, targetDir, pnpmCacheDir, cachedModuleMap, copyMap, depStack) {
    const installedModule = depTree.installedDependencies[moduleName];
    if (installedModule) {
        // Copy from local node_modules directory.
        return await _copyDependency(installedModule, requiredVersion, depTree, targetDir, pnpmCacheDir, cachedModuleMap, copyMap, [installedModule, ...depStack]);
    }
    else {
        // Copy from .pnpm cache.
        const cachedModule = cachedModuleMap[moduleName];
        if (!cachedModule) {
            const stack = depStack.map(module => `\t${module.name}:${module.version}`).join("\r\n");
            console.error(`Could not find ${moduleName}:${requiredVersion} in .pnpm cache. Required by:\r\n${stack}`);
        }
        else {
            const cachedModuleVersions = Object.values(cachedModule);
            cachedModuleVersions.sort(compareVersionsDescending);

            //
            // Find the first module that matches.
            //
            let lastSatisfyingVersion = undefined;

            for (const cachedModuleVersion of cachedModuleVersions) {
                if (!semver.satisfies(cachedModuleVersion.version, requiredVersion)) {
                    if (semver.lt(cachedModuleVersion.version, semver.coerce(requiredVersion))) {
                        break;
                    }

                    continue;
                }

                lastSatisfyingVersion = cachedModuleVersion;
            }

            if (lastSatisfyingVersion) {
                return await _copyDependency(lastSatisfyingVersion, requiredVersion, depTree, targetDir, pnpmCacheDir, cachedModuleMap, copyMap, [lastSatisfyingVersion, ...depStack]);
            }
            else {
                const stack = depStack.map(module => `\t${module.name}:${module.version}`).join("\r\n");
                console.error(
                    `Could not find a satisfying version of ${moduleName}:${requiredVersion} in .pnpm cache.\r\n` +
                    `Found versions:\r\n` +
                    `  ` + cachedModuleVersions.map(v => v.version).join("\r\n  ") + `\r\n` +
                    `Required by:\r\n${stack}`
                );
            }
        }
    }

    return 0;
}

//
// Copy all required dependencies to the target directory.
//
async function copyDependencies(depTree, targetDir, pnpmCacheDir, cachedModuleMap, copyMap, depStack) {
	let numModules = 0;
    for (const [moduleName, requiredVersion] of Object.entries(depTree.wantDependencies)) {
    	numModules += await copyDependency(depTree, moduleName, requiredVersion, targetDir, pnpmCacheDir, cachedModuleMap, copyMap, depStack);
    }
    return numModules;
}

//
// Hoist all modules from the source module's "node_modules" to the target directory.
//
async function hoist(sourceDir, targetDir, options) {

    console.time("total");
    console.time("load-cache");

    sourceDir = path.resolve(sourceDir);
    targetDir = path.resolve(targetDir);

    const pnpmCacheDir = await findPnpmDir(sourceDir);
    const cachedModuleMap = {};
    if (pnpmCacheDir) {
        console.log(`Found .pnpm directory at ${pnpmCacheDir}.`);
        const cachedModules = await fs.readdir(pnpmCacheDir);
        for (const moduleName of cachedModules) {
            const dir = path.join(pnpmCacheDir, moduleName, "node_modules");
            const dependencies = await readInstalledDependencies(dir, options);
            for (const dependency of dependencies) {
                const existingModule = cachedModuleMap[dependency.name];
                if (!existingModule) {
                    cachedModuleMap[dependency.name] = {
                        [dependency.version]: dependency,
                    };
                }
                else {
                    existingModule[dependency.version] = dependency;
                }
            }
        }
    }

    console.timeLog("load-cache");

    console.time("build-dependency-tree");
    const depTree = await buildDependencyTree(sourceDir, options);
    depTree.targetDir = targetDir;
    console.timeLog("build-dependency-tree");

    console.time("copy-modules");
    const copyMap = {};
    const numModules = await copyDependencies(depTree, targetDir, pnpmCacheDir, cachedModuleMap, copyMap, [ depTree ]);
    console.timeLog("copy-modules");
    console.timeLog("total");
    console.log(`Copied ${numModules} modules.`);
    console.log(`Done.`);
}

async function main() {
    var argv = minimist(process.argv.slice(2));
    if (argv._.length !== 2) {
        console.error(`Need two arguments.`);
        console.error(`Usage: hoist-modules <sourceDir> <targetDir> [--force]`);
        process.exit(1);
    }

    const force = argv.force;
    const devDependencies = argv.dev;
    const sourceDir = argv._[0];
    const targetDir = argv._[1];

    if (await fs.pathExists(targetDir)) {
        if (force) {
            // console.log(`Removing existing target directory ${targetDir}`);
            await fs.remove(targetDir);
        }
        else {
            throw new Error(`Target directory ${targetDir} already exists. Use --force to overwrite.`);
        }
    }

    await hoist(sourceDir, targetDir, { devDependencies });
}

module.exports = {
    hoist,
    main,
};
