const minimist = require("minimist");
const fs = require("fs-extra");
const path = require("path");

//
// Walk all nested subdirectories of a node_modules directory and build an index of modules.
//
async function indexNodeModules(dir, modulePrefix, moduleIndex) {
    
    const files = await fs.readdir(dir);

    for (const file of files) {
        if (file.startsWith(".")) {
            continue;
        }

        const packagePath = `${dir}/${file}`;

        if (file.startsWith("@")) {
            await indexNodeModules(packagePath, `${file}/`, moduleIndex);
            continue;
        }

        const packageNodeModulesPath = `${packagePath}/node_modules`;
        if (await fs.pathExists(packageNodeModulesPath)) {
            //
            // Nested modules.
            //
            await indexNodeModules(packageNodeModulesPath, "", moduleIndex);
        }

        //
        // Load version number for the package.
        //
        const packageJsonPath = `${packagePath}/package.json`;
        const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
        const packageVersion = packageJson.version;

        //
        // Add this package to the index.
        //
        const moduleName = `${modulePrefix}${file}`;
        if (moduleIndex[moduleName] === undefined) {
            moduleIndex[moduleName] = {
                name: moduleName,
                version: packageVersion,
                paths: [
                    packagePath,
                ],
            };
        }
        else {
            const moduleRecord = moduleIndex[moduleName];
            if (moduleRecord.version !== packageVersion) {
                throw new Error(`Version mismatch for module ${moduleName}: ${moduleRecord.version} vs ${packageVersion}`);
            }
            moduleRecord.paths.push(packagePath);
        }
    }
}

//
// Recursively copy all files from one directory to another.
//
async function copyDir(srcDir, destDir) {

    await fs.ensureDir(destDir);

    const entries = await fs.readdir(srcDir, { withFileTypes: true });

    for (let entry of entries) {
        if (entry.name === "node_modules") {
            // console.log(`Skipping nested node_modules directory in ${srcDir}`);
            continue;
        }
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
            await copyDir(srcPath, destPath);
        } else {
            await fs.copy(srcPath, destPath);
        }
    }
}
//
// Hoist all modules to the root and remove duplicates.
//
// NOTE: This assumes all modules are the same version. A 
// better implementation would check for version conflicts.
//
async function hoistModules(moduleIndex, targetDir) {

    let total = 0;
    let copied = 0;

    for ([ moduleName, moduleRecord ] of Object.entries(moduleIndex)) {
        if (moduleRecord.paths.length === 0) {
            continue;
        }

        //
        // Copy the first duplicate to the target path.
        //
        const modulePath = moduleRecord.paths[0];
        const targetPath = `${targetDir}/${moduleName}`;
        await copyDir(modulePath, targetPath);
        copied += 1;
        total += moduleRecord.paths.length;
    }

    console.log(`Original modules: ${total}`);
    console.log(`Hoisted modules: ${copied}`);
}

async function main() {
    var argv = minimist(process.argv.slice(2));
    const sourceDir = argv._[0];
    const targetDir = "./tmp";

    console.log(`Hoisting modules from ${sourceDir} to ${targetDir}`);

    if (await fs.pathExists(targetDir)) {
        if (argv.force) {
            console.log(`Removing existing target directory ${targetDir}`);
            await fs.remove(targetDir);
        }
        else {
            throw new Error(`Target directory ${targetDir} already exists. Use --force to overwrite.`);
        }
    }

    const moduleIndex = {};
    await indexNodeModules(sourceDir, "", moduleIndex);
    console.log(moduleIndex);

    await fs.ensureDir(targetDir);
    await hoistModules(moduleIndex, targetDir); 

    console.log(`Done.`);
}

main()
    .catch(err => {
        console.error(`Failed with error:`);
        console.error(err && err.stack || err);
        process.exit(1);
    });