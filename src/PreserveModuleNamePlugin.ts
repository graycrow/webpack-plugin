import * as path from "path";
import * as Webpack from "webpack";
import { createLogger } from "./logger";

export const preserveModuleName = Symbol();

const TAP_NAME = "Aurelia:PreserveModuleName";
const logger = createLogger('PreserveModuleNamePlugin');

// This plugins preserves the module names of IncludeDependency and 
// AureliaDependency so that they can be dynamically requested by 
// aurelia-loader.
// All other dependencies are handled by webpack itself and don't
// need special treatment.
export class PreserveModuleNamePlugin {

  constructor(private isDll: boolean = false) {
  }

  apply(compiler: Webpack.Compiler) {
    compiler.hooks.compilation.tap(TAP_NAME, compilation => {
      compilation.hooks.beforeModuleIds.tap(TAP_NAME, $modules => {
        let modules = Array.from($modules) as Webpack.NormalModule[];
        let { modules: m, extensions: e, alias: a } = compilation.options.resolve;
        let roots = m as string[];
        let extensions = e as string[];
        // if it's not an object, it's pretty hard to guess how to map to common usage of alias
        // temporarily not handle anything that is not a record of aliases
        let alias = a == null || a instanceof Array ? {} : a;

        roots = roots.map(x => path.resolve(x));
        const normalizers = extensions.map(x => new RegExp(x.replace(/\./g, "\\.") + "$", "i"));

        // ModuleConcatenationPlugin merges modules into new ConcatenatedModule
        let modulesBeforeConcat = modules.slice();
        for (let i = 0; i < modulesBeforeConcat.length; i++) {
          let m = modulesBeforeConcat[i];
          // TODO: verify if this still works
          // ==================================================
          // We don't `import ConcatenatedModule` and then `m instanceof ConcatenatedModule`
          // because it was introduced in Webpack 3.0 and we're still compatible with 2.x at the moment.
          if (m.constructor.name === "ConcatenatedModule")
            modulesBeforeConcat.splice(i--, 1, ...m["modules"]);
        }

        for (let module of getPreservedModules(modules, compilation)) {
          // Even though it's imported by Aurelia, it's still possible that the module
          // became the _root_ of a ConcatenatedModule.
          // We use `constructor.name` rather than `instanceof` for compat. with Webpack 2.
          let realModule = module;
          if (module.constructor.name === "ConcatenatedModule")
            realModule = module["rootModule"];

          let preserve: string | true | undefined = realModule[preserveModuleName];
          let id = typeof preserve === "string" ? preserve : null;

          // No absolute request to preserve, we try to normalize the module resource
          if (!id && realModule.resource)
            id = fixNodeModule(realModule, modulesBeforeConcat) || 
                 makeModuleRelative(roots, realModule.resource) ||
                 aliasRelative(alias, realModule.resource);

          if (!id)
            throw new Error(`Can't figure out a normalized module name for ${realModule.rawRequest}, please call PLATFORM.moduleName() somewhere to help.`);

          // Remove default extensions 
          normalizers.forEach(n => id = id!.replace(n, ""));

          // Keep "async!" in front of code splits proxies, they are used by aurelia-loader
          if (/^async[?!]/.test(realModule.rawRequest)) 
            id = "async!" + id;

          id = id.replace(/\\/g, "/");
          if (module.buildMeta)  // meta can be null if the module contains errors
            module.buildMeta["aurelia-id"] = id;

          if (!this.isDll) {
            compilation.chunkGraph.setModuleId(module, id);
          }
        }
      });
    });
  }
};

function getPreservedModules(modules: Webpack.NormalModule[], compilation: Webpack.Compilation) {
  return new Set(
    modules.filter(m => {
      // Some modules might have [preserveModuleName] already set, see ConventionDependenciesPlugin.
      let value = m[preserveModuleName];
      for (let connection of compilation.moduleGraph.getIncomingConnections(m)) {
        // todo: verify against commented code below
        if (!connection?.dependency?.[preserveModuleName]) {
          continue;
        }

        value = true;
        let req = removeLoaders((connection.dependency as Webpack.dependencies.ModuleDependency).request);
        // We try to find an absolute string and set that as the module [preserveModuleName], as it's the best id.
        if (req && !req.startsWith(".")) {
          m[preserveModuleName] = req;
          return true;
        }
      }
      return !!value;
    })
  );
}

function aliasRelative(aliases: {[key: string]: string | false | string[] } | null, resource: string) {
  // We consider that aliases point to local folder modules.
  // For example: `"my-lib": "../my-lib/src"`.
  // Basically we try to make the resource relative to the alias target,
  // and if it works we build the id from the alias name.
  // So file `../my-lib/src/index.js` becomes `my-lib/index.js`.
  // Note that this only works with aliases pointing to folders, not files.
  // To have a "default" file in the folder, the following construct works:
  // alias: { "mod$": "src/index.js", "mod": "src" }
  if (!aliases) return null;

  for (let name in aliases) {
    let target = aliases[name];
    // TODO:
    // not sure how to handle anything other than a simple mapping yet
    // just ignore for now
    if (typeof target !== 'string')
      continue;
    let root = path.resolve(target);
    let relative = path.relative(root, resource);
    if (relative.startsWith("..")) continue;
    name = name.replace(/\$$/, ""); // A trailing $ indicates an exact match in webpack
    return relative ? name + "/" + relative : name;
  }
  return null;
}

function makeModuleRelative(roots: string[], resource: string) {
  for (let root of roots) {
    let relative = path.relative(root, resource);
    if (!relative.startsWith("..")) return relative;
  }
  return null;
}

function fixNodeModule(module: Webpack.NormalModule, allModules: Webpack.NormalModule[]) {
  if (!/\bnode_modules\b/i.test(module.resource)) return null;
  // The problem with node_modules is that often the root of the module is not /node_modules/my-lib
  // Webpack is going to look for `main` in `project.json` to find where the main file actually is.
  // And this can of course be configured differently with `resolve.alias`, `resolve.mainFields` & co.
  
  // Our best hope is that the file was not required as a relative path, then we can just preserve that.
  // We just need to be careful with loaders (e.g. async!)
  let request = removeLoaders(module.rawRequest)!;  // we assume that Aurelia dependencies always have a rawRequest
  if (!request.startsWith(".")) return request;

  // Otherwise we need to build the relative path from the module root, which as explained above is hard to find.
  // Ideally we could use webpack resolvers, but they are currently async-only, which can't be used in before-modules-id
  // See https://github.com/webpack/webpack/issues/1634
  // Instead, we'll look for the root library module, because it should have been requested somehow and work from there.
  // Note that the negative lookahead (?!.*node_modules) ensures that we only match the last node_modules/ folder in the path,
  // in case the package was located in a sub-node_modules (which can occur in special circumstances).
  // We also need to take care of scoped modules. If the name starts with @ we must keep two parts,
  // so @corp/bar is the proper module name.
  let name = /\bnode_modules[\\/](?!.*\bnode_modules\b)((?:@[^\\/]+[\\/])?[^\\/]+)/i.exec(module.resource)![1];
  if (!name) {
    logger.log('issue while fixing node modules: not a node module', module.resource);
    return;
  }
  name = name.replace("\\", "/"); // normalize \ to / for scoped modules
  let entry = allModules.find(m => removeLoaders(m.rawRequest) === name);
  if (entry) 
    return name + "/" + path.relative(path.dirname(entry.resource), module.resource);
  // We could not find the raw module. Let's try to find another a more complex entry point.
  for (let m of allModules) {
    let req = removeLoaders(m.rawRequest);
    if (!req || !req.startsWith(name) || !m.resource) continue;
    let i = m.resource.replace(/\\/g, "/").lastIndexOf(req.substr(name.length));
    if (i < 0) continue;
    let root = m.resource.substr(0, i);
    return name + "/" + path.relative(root, module.resource);
  }
  throw new Error("PreserveModuleNamePlugin: Unable to find root of module " + name);
}

function removeLoaders(request: string | undefined) {
  // We have to be careful, as it seems that in the allModules.find() call above
  // some modules might have m.rawRequst === undefined
  if (!request) return request;
  let lastBang = request.lastIndexOf("!");
  return lastBang < 0 ? request : request.substr(lastBang + 1);
}
