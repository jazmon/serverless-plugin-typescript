import * as fs from 'fs-extra';
import * as path from 'path';
import { uniq } from 'lodash';
import globby from 'globby';
// import * as _ from 'lodash';

import {
  ServerlessFunction,
  ServerlessInstance,
  ServerlessOptions,
} from './types';
import * as typescript from './typescript';

import { watchFiles } from './watchFiles';

// Folders
const serverlessFolder = '.serverless';
const buildFolder = '.build';

export class TypeScriptPlugin {
  get functions() {
    return this.options.function
      ? {
          [this.options.function]: this.serverless.service.functions[
            this.options.function
          ],
        }
      : this.serverless.service.functions;
  }

  get rootFileNames() {
    return typescript.extractFileNames(
      this.originalServicePath || '',
      this.serverless.service.provider.name,
      this.functions,
    );
  }

  public serverless: ServerlessInstance;
  public options: ServerlessOptions;
  // public commands: { [key: string]: any };
  public hooks: { [key: string]: Function };
  private originalServicePath: null | string = null;
  private isWatching: boolean = false;

  constructor(serverless: ServerlessInstance, options: ServerlessOptions) {
    this.serverless = serverless;
    this.options = options;

    this.hooks = {
      'before:run:run': async () => {
        await this.compileTs();
      },
      'before:offline:start': async () => {
        await this.compileTs();
        this.watchAll();
      },
      'before:offline:start:init': async () => {
        await this.compileTs();
        this.watchAll();
      },
      'before:package:createDeploymentArtifacts': this.compileTs.bind(this),
      'after:package:createDeploymentArtifacts': this.cleanup.bind(this),
      'before:deploy:function:packageFunction': this.compileTs.bind(this),
      'after:deploy:function:packageFunction': this.cleanup.bind(this),
      'before:invoke:local:invoke': async () => {
        const emitedFiles = await this.compileTs();
        if (this.isWatching) {
          emitedFiles.forEach(filename => {
            const module = require.resolve(
              path.resolve(this.originalServicePath || '', filename),
            );
            delete require.cache[module];
          });
        }
      },
      'after:invoke:local:invoke': () => {
        if (this.options.watch) {
          this.watchFunction();
          this.serverless.cli.log('Waiting for changes ...');
        }
      },
    };
  }

  public prepare() {
    // exclude serverless-plugin-typescript
    const functions = this.functions;
    for (const fnName in functions) {
      const fn = functions[fnName];
      fn.package = fn.package || {
        exclude: [],
        include: [],
      };
      // Add plugin to excluded packages or an empty array if exclude is undefined
      fn.package.exclude = uniq([
        ...(fn.package.exclude || []),
        'node_modules/serverless-plugin-typescript',
      ]);
    }
  }

  public async watchFunction(): Promise<void> {
    if (this.isWatching) {
      return;
    }

    this.serverless.cli.log(`Watch function ${this.options.function}...`);

    this.isWatching = true;
    watchFiles(this.rootFileNames, this.originalServicePath || '', () => {
      this.serverless.pluginManager.spawn('invoke:local');
    });
  }

  public async watchAll(): Promise<void> {
    if (this.isWatching) {
      return;
    }

    this.serverless.cli.log(`Watching typescript files...`);

    this.isWatching = true;
    watchFiles(this.rootFileNames, this.originalServicePath || '', () => {
      this.compileTs();
    });
  }

  public async compileTs(): Promise<string[]> {
    this.prepare();
    this.serverless.cli.log('Compiling with Typescript...');

    if (!this.originalServicePath) {
      // Save original service path and functions
      this.originalServicePath = this.serverless.config.servicePath;
      // Fake service path so that serverless will know what to zip
      this.serverless.config.servicePath = path.join(
        this.originalServicePath,
        buildFolder,
      );
    }

    const tsconfig = typescript.getTypescriptConfig(
      this.originalServicePath,
      this.isWatching ? null : this.serverless.cli,
    );

    tsconfig.outDir = buildFolder;

    const emitedFiles = await typescript.run(this.rootFileNames, tsconfig);
    await this.copyExtras();
    this.serverless.cli.log('Typescript compiled.');
    return emitedFiles;
  }

  public async copyExtras() {
    // include node_modules into build
    if (!fs.existsSync(path.resolve(path.join(buildFolder, 'node_modules')))) {
      fs.symlinkSync(
        path.resolve('node_modules'),
        path.resolve(path.join(buildFolder, 'node_modules')),
      );
    }

    // include package.json into build so Serverless can exlcude devDeps during packaging
    if (!fs.existsSync(path.resolve(path.join(buildFolder, 'package.json')))) {
      fs.symlinkSync(
        path.resolve('package.json'),
        path.resolve(path.join(buildFolder, 'package.json')),
      );
    }

    // include any "extras" from the "include" section
    if (
      this.serverless.service.package.include &&
      this.serverless.service.package.include.length > 0
    ) {
      const files = await globby(this.serverless.service.package.include);

      for (const filename of files) {
        const destFileName = path.resolve(path.join(buildFolder, filename));
        const dirname = path.dirname(destFileName);

        if (!fs.existsSync(dirname)) {
          fs.mkdirpSync(dirname);
        }

        if (!fs.existsSync(destFileName)) {
          fs.copySync(
            path.resolve(filename),
            path.resolve(path.join(buildFolder, filename)),
          );
        }
      }
    }
  }

  public async moveArtifacts(): Promise<void> {
    if (this.originalServicePath === null) return;
    await fs.copy(
      path.join(this.originalServicePath, buildFolder, serverlessFolder),
      path.join(this.originalServicePath, serverlessFolder),
    );

    if (this.options.function) {
      const fn = this.serverless.service.functions[this.options.function];
      const basename = path.basename(fn.package.artifact || '');
      fn.package.artifact = path.join(
        this.originalServicePath,
        serverlessFolder,
        basename,
      );
      return;
    }

    if (this.serverless.service.package.individually) {
      const functionNames = this.serverless.service.getAllFunctions();
      functionNames.forEach(name => {
        this.serverless.service.functions[name].package.artifact = path.join(
          this.originalServicePath || '',
          serverlessFolder,
          path.basename(
            this.serverless.service.functions[name].package.artifact || '',
          ),
        );
      });
      return;
    }

    this.serverless.service.package.artifact = path.join(
      this.originalServicePath,
      serverlessFolder,
      path.basename(this.serverless.service.package.artifact || ''),
    );
  }

  public async cleanup(): Promise<void> {
    await this.moveArtifacts();
    // Restore service path
    this.serverless.config.servicePath = this.originalServicePath || '';
    // Remove temp build folder
    fs.removeSync(path.join(this.originalServicePath || '', buildFolder));
  }
}

module.exports = TypeScriptPlugin;
