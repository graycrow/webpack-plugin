import * as webpack from 'webpack';

export const dependencyImports = Symbol();
const moduleExports = Symbol();
const nativeIsUsed = Symbol();

const TAP_NAME = "Aurelia:PreserveExports";

// type Writable<T> = { -readonly [K in keyof T]: T[K] };

export class PreserveExportsPlugin {
  apply(compiler: webpack.Compiler) {
    compiler.hooks.compilation.tap(TAP_NAME, compilation => {
      compilation.hooks.finishModules.tap(TAP_NAME, modules => {
        for (let module of modules as Iterable<webpack.NormalModule>) {
          // TODO:
          // verify against commented code below
          for (const connection of compilation.moduleGraph.getIncomingConnections(module)) {
            let dep = connection.dependency;
            let imports = dep?.[dependencyImports];
            if (!imports) {
              continue;
            }

            // let set = compilation.moduleGraph.getExportsInfo(module);
            let set = getModuleExports(module, compilation.moduleGraph);

            for (let e of imports)
              set.add(e);
          }
          // for (let reason of module.reasons) {
          //   let dep = reason.dependency;
          //   let imports = dep[dependencyImports];
          //   if (!imports) {
          //     continue;
          //   }

          //   let set = getModuleExports(module);
          //   for (let e of imports)
          //     set.add(e);
          // }
        }
      });
    });
  }
}

function getModuleExports(module: webpack.NormalModule, moduleGraph: webpack.ModuleGraph) {
  let exportsInfo = moduleGraph.getExportsInfo(module);
  let _set = exportsInfo[moduleExports];
  if (!_set) {
    exportsInfo[moduleExports] = _set = new Set();
    exportsInfo[nativeIsUsed] = exportsInfo.isModuleUsed;
    exportsInfo.getUsedName = function(name, runtime) {
      console.log('getUsedName', name);
      return _set.has(name)
        ? name
        : this[nativeIsUsed](name, runtime);
    };
    // (module as Writable<webpack.Module>).isUsed = function (this: webpack.Module, name: string) {
    // return this[moduleExports].has(name) ?
    //   name :
    //   module[nativeIsUsed](name);
    // };
  }
  return _set;
  // let set = module[moduleExports];
  // if (!set) {
  //   module[moduleExports] = set = new Set();
  //   module[nativeIsUsed] = module.isUsed;
  //   (module as Writable<webpack.Module>).isUsed = function (this: webpack.Module, name: string) {
  //   return this[moduleExports].has(name) ?
  //     name :
  //     module[nativeIsUsed](name);
  //   };
  // }
  // return set;
}
