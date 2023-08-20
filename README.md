# hoist-modules

A small program to dedup Node.js modules and hoist them up to the root node_modules directory.

This module fixes a problem in the build process for [Data-Forge Notebook](https://www.data-forge-notebook.com/). Using pnpm produces symbolic links to shared modules between packages in a workspace. Unfortunately this messes up the Electron build because it converts the symbolic links to duplicate modules.

[Click here to support my work](https://www.codecapers.com.au/about#support-my-work).

## Usage

```bash
npm install -g hoist-modules
hoist-modules <root-node_modules-directory> <target-dir> [--force]
```

## Run it for development

Setup:

```bash
cd hoist-modules
npm install
```

Run it:

```bash
npm run start -- <root-node_modules-directory> <target-dir> -- --force
```

Or run it with live reload: 

```bash
npm run dev -- <root-node_modules-directory> <target-dir> -- --force
```

npm run dev --  c:/projects/data-forge-notebook/editor-core/shells/electron/node_modules -- --force