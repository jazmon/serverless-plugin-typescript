import { extractFileNames } from './typescript';
import * as Serverless from 'serverless';
// import { ServerlessFunction } from './types';
import * as path from 'path';

const functions: { [key: string]: Serverless.FunctionDefinition } = {
  hello: {
    name: 'hello',
    handler: 'my-folder/hello.handler',
    package: {
      include: [],
      exclude: [],
    },
  },
  world: {
    name: 'world',
    handler: 'my-folder/my-subfolder/world.handler',
    package: {
      include: [],
      exclude: [],
    },
  },
  create: {
    name: 'create',
    handler: 'create.create',
    package: {
      include: [],
      exclude: [],
    },
  },
};

describe('extractFileName', () => {
  it('get function filenames from serverless service for a non-google provider', () => {
    expect(extractFileNames(process.cwd(), 'aws', functions)).toEqual([
      'my-folder/hello.ts',
      'my-folder/my-subfolder/world.ts',
      'create.ts',
    ]);
  });

  it('get function filename from serverless service for a google provider', () => {
    expect(
      extractFileNames(path.join(process.cwd(), 'example'), 'google'),
    ).toEqual(['handler.ts']);
  });
});
