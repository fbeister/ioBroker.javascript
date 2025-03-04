/*
 * Javascript adapter
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2014-2019 bluefox <dogafox@gmail.com>,
 *
 * Copyright (c) 2014      hobbyquaker
*/

/* jshint -W097 */
/* jshint -W083 */
/* jshint strict: false */
/* jslint node: true */
/* jshint shadow: true */
'use strict';

let NodeVM;
let VMScript;
let vm;
if (true || parseInt(process.versions.node.split('.')[0]) < 6) {
    vm = require('vm');
} else {
    try {
        const VM2 = require('vm2');
        NodeVM = VM2.NodeVM;
        VMScript = VM2.VMScript;
    } catch (e) {
        vm = require('vm');
    }
}
const nodeFS         = require('fs');
const nodePath       = require('path');
const coffeeCompiler = require('coffee-compiler');
const tsc            = require('virtual-tsc');
const typescript     = require('typescript');
const nodeSchedule   = require('node-schedule');
const Mirror         = require('./lib/mirror');

const mods = {
    fs:               {},
    dgram:            require('dgram'),
    crypto:           require('crypto'),
    dns:              require('dns'),
    events:           require('events'),
    http:             require('http'),
    https:            require('https'),
    net:              require('net'),
    os:               require('os'),
    path:             require('path'),
    util:             require('util'),
    child_process:    require('child_process'),
    suncalc:          require('suncalc2'),
    request:          require('request'),
    wake_on_lan:      require('wake_on_lan')
};

const utils     = require('@iobroker/adapter-core'); // Get common adapter utils
const words     = require('./lib/words');
const sandBox   = require('./lib/sandbox');
const eventObj  = require('./lib/eventObj');
const Scheduler = require('./lib/scheduler');
const { 
    resolveTypescriptLibs,
    resolveTypings,
    scriptIdToTSFilename
} = require('./lib/typescriptTools');

const adapterName = require('./package.json').name.split('.').pop();

// for node version <= 0.12
if (''.startsWith === undefined) {
    String.prototype.startsWith = function (s) {
        return this.indexOf(s) === 0;
    };
}
if (''.endsWith === undefined) {
    String.prototype.endsWith = function (s) {
        return this.slice(0 - s.length) === s;
    };
}
///

let webstormDebug;
if (process.argv) {
    for (let a = 1; a < process.argv.length; a++) {
        if (process.argv[a].startsWith('--webstorm')) {
            webstormDebug = process.argv[a].replace(/^(.*?=\s*)/, '');
            break;
        }
    }
}

// NodeJS 8+ supports the features of ES2017
// When upgrading the minimum supported version to NodeJS 10 or higher,
// consider changing this, so we get to support the newest features too
const targetTsLib = 'es2017';

/** @type {typescript.CompilerOptions} */
const tsCompilerOptions = {
    // don't compile faulty scripts
    noEmitOnError: true,
    // emit declarations for global scripts
    declaration: true,
    // This enables TS users to `import * as ... from` and `import ... from`
    esModuleInterop: true,
    // In order to run scripts as a NodeJS vm.Script,
    // we need to target ES5, otherwise the compiled
    // scripts may include `import` keywords, which are not
    // supported by vm.Script.
    target: typescript.ScriptTarget.ES5,
    lib: [`lib.${targetTsLib}.d.ts`],
};

const jsDeclarationCompilerOptions = Object.assign(
    {}, tsCompilerOptions,
    {
        // we only care about the declarations
        emitDeclarationOnly: true,
        // allow errors
        noEmitOnError: false,
        noImplicitAny: false,
        strict: false,
    }
);

// ambient declarations for typescript
/** @type {Record<string, string>} */
let tsAmbient;
/** @type {tsc.Server} */
let tsServer;
/** @type {tsc.Server} */
let jsDeclarationServer;

let mirror;

/** @type {boolean} if logs are subscribed or not */
let logSubscribed;

/**
 * @param {string} scriptID - The current script the declarations were generated from
 * @param {string} declarations
 */
function provideDeclarationsForGlobalScript(scriptID, declarations) {
    // Remember which declarations this global script had access to
    // we need this so the editor doesn't show a duplicate identifier error
    if (globalDeclarations != null && globalDeclarations !== '') {
        knownGlobalDeclarationsByScript[scriptID] = globalDeclarations;
    }
    // and concatenate the global declarations for the next scripts
    globalDeclarations += declarations + '\n';
    // remember all previously generated global declarations,
    // so global scripts can reference each other
    const globalDeclarationPath = 'global.d.ts';
    tsAmbient[globalDeclarationPath] = globalDeclarations;
    // make sure the next script compilation has access to the updated declarations
    tsServer.provideAmbientDeclarations({
        [globalDeclarationPath]: globalDeclarations
    });
    jsDeclarationServer.provideAmbientDeclarations({
        [globalDeclarationPath]: globalDeclarations
    });
}

function loadTypeScriptDeclarations() {
    // try to load the typings on disk for all 3rd party modules
    const packages = [
        'node', // this provides auto completion for most builtins
        'request', // preloaded by the adapter
    ];
    // Also include user-selected libraries (but only those that are also installed)
    if (
        adapter.config
        && typeof adapter.config.libraries === 'string'
        && typeof adapter.config.libraryTypings === 'string'
    ) {
        const installedLibs = adapter.config.libraries.split(/[,;\s]+/).map(s => s.trim());
        const wantsTypings = adapter.config.libraryTypings.split(/[,;\s]+/).map(s => s.trim());
        for (const lib of installedLibs) {
            if (
                wantsTypings.indexOf(lib) > -1
                && packages.indexOf(lib) === -1
            ) {
                packages.push(lib);
            }
        }
    }
    for (const pkg of packages) {
        const pkgTypings = resolveTypings(
            pkg,
            // node needs ambient typings, so we don't wrap it in declare module
            pkg !== 'node'
        );
        adapter.log.debug(`Loaded TypeScript definitions for ${pkg}: ${JSON.stringify(Object.keys(pkgTypings))}`);
        // remember the declarations for the editor
        Object.assign(tsAmbient, pkgTypings);
        // and give the language servers access to them
        tsServer.provideAmbientDeclarations(pkgTypings);
        jsDeclarationServer.provideAmbientDeclarations(pkgTypings);
    }
}


const context = {
    mods,
    objects:          {},
    states:           {},
    stateIds:         [],
    errorLogFunction: null,
    subscriptions:    [],
    adapterSubs:      {},
    subscribedPatterns: {},
    cacheObjectEnums: {},
    isEnums:          false, // If some subscription wants enum
    channels:         null,
    devices:          null,
    logWithLineInfo:  null,
    scheduler:        null,
    timers:           {},
    enums:            [],
    timerId:          0,
    names:            {},
    scripts:          {},
    messageBusHandlers: {},
    logSubscriptions: {},
    updateLogSubscriptions,
};

const regExGlobalOld = /_global$/;
const regExGlobalNew = /script\.js\.global\./;

function checkIsGlobal(obj) {
    return regExGlobalOld.test(obj.common.name) || regExGlobalNew.test(obj._id);
}

let adapter;

function startAdapter(options) {
    options = options || {};
    Object.assign(options, {

        name: adapterName,

        useFormatDate: true, // load float formatting

        objectChange: (id, obj) => {
            if (id.startsWith('enum.')) {
                // clear cache
                context.cacheObjectEnums = {};

                // update context.enums array
                if (obj) {
                    // If new
                    if (context.enums.indexOf(id) === -1) {
                        context.enums.push(id);
                        context.enums.sort();
                    }
                } else {
                    const pos = context.enums.indexOf(id);
                    // if deleted
                    if (pos !== -1) {
                        context.enums.splice(pos, 1);
                    }
                }
            }

            // send changes to disk mirror
            mirror && mirror.onObjectChange(id, obj);

            if (obj) {
                // add state to state ID's list
                if (obj.type === 'state' && context.stateIds.indexOf(id) === -1) {
                    context.stateIds.push(id);
                    context.stateIds.sort();
                }
            } else {
                // delete object from state ID's list
                const pos = context.stateIds.indexOf(id);
                pos !== -1 && context.stateIds.splice(pos, 1);
            }

            if (!obj) {
                // object deleted
                if (!context.objects[id]) return;

                // Script deleted => remove it
                if (context.objects[id].type === 'script' && context.objects[id].common.engine === 'system.adapter.' + adapter.namespace) {
                    stop(id);

                    // delete scriptEnabled.blabla variable
                    const idActive = 'scriptEnabled.' + id.substring('script.js.'.length);
                    adapter.delObject(idActive);
                    adapter.delState(idActive);

                    // delete scriptProblem.blabla variable
                    const idProblem = 'scriptProblem.' + id.substring('script.js.'.length);
                    adapter.delObject(idProblem);
                    adapter.delState(idProblem);
                }

                removeFromNames(id);
                delete context.objects[id];
            } else if (!context.objects[id]) {
                // New object
                context.objects[id] = obj;

                addToNames(obj);

                if (obj.type === 'script' && obj.common.engine === 'system.adapter.' + adapter.namespace) {
                    // create states for scripts
                    createActiveObject(id, obj.common.enabled, () => createProblemObject(id));

                    if (obj.common.enabled) {
                        if (checkIsGlobal(obj)) {
                            // restart adapter
                            adapter.getForeignObject('system.adapter.' + adapter.namespace, (err, _obj) =>
                                _obj && adapter.setForeignObject('system.adapter.' + adapter.namespace, _obj));
                            return;
                        }

                        // Start script
                        load(id);
                    }
                }
                // added new script to this engine
            } else if (context.objects[id].common) {
                const n = getName(id);

                if (n !== context.objects[id].common.name) {
                    if (n) removeFromNames(id);
                    if (context.objects[id].common.name) addToNames(obj);
                }

                // Object just changed
                if (obj.type !== 'script') {
                    context.objects[id] = obj;

                    if (id === 'system.config') {
                        // set language for debug messages
                        if (obj.common && obj.common.language) {
                            words.setLanguage(obj.common.language);
                        }
                    }

                    return;
                }

                // Analyse type = 'script'

                if (checkIsGlobal(context.objects[id])) {
                    // restart adapter
                    adapter.getForeignObject('system.adapter.' + adapter.namespace, (err, obj) =>
                        obj && adapter.setForeignObject('system.adapter.' + adapter.namespace, obj));

                    return;
                }

                if (obj.common && obj.common.engine === 'system.adapter.' + adapter.namespace) {
                    // create states for scripts
                    createActiveObject(id, obj.common.enabled, () => createProblemObject(id));
                }

                if ((context.objects[id].common.enabled && !obj.common.enabled) ||
                    (context.objects[id].common.engine === 'system.adapter.' + adapter.namespace && obj.common.engine !== 'system.adapter.' + adapter.namespace)) {

                    // Script disabled
                    if (context.objects[id].common.enabled && context.objects[id].common.engine === 'system.adapter.' + adapter.namespace) {
                        // Remove it from executing
                        context.objects[id] = obj;
                        stop(id);
                    } else {
                        context.objects[id] = obj;
                    }
                } else if ((!context.objects[id].common.enabled && obj.common.enabled) ||
                    (context.objects[id].common.engine !== 'system.adapter.' + adapter.namespace && obj.common.engine === 'system.adapter.' + adapter.namespace)) {
                    // Script enabled
                    context.objects[id] = obj;

                    if (context.objects[id].common.enabled && context.objects[id].common.engine === 'system.adapter.' + adapter.namespace) {
                        // Start script
                        load(id);
                    }
                } else { //if (obj.common.source !== context.objects[id].common.source) {
                    context.objects[id] = obj;

                    // Source changed => restart it
                    stop(id, (res, _id) =>
                        load(_id));
                } /*else {
                // Something changed or not for us
                objects[id] = obj;
            }*/
            }
        },

        stateChange: (id, state) => {
            if (!id || id.startsWith('messagebox.') || id.startsWith('log.')) {
                return;
            }

            const oldState = context.states[id];
            if (state) {
                if (oldState) {
                    // enable or disable script
                    if (!state.ack && id.startsWith(activeStr) && context.objects[id] && context.objects[id].native && context.objects[id].native.script) {
                        adapter.extendForeignObject(context.objects[id].native.script, { common: { enabled: state.val } });
                    }

                    // monitor if adapter is alive and send all subscriptions once more, after adapter goes online
                    if (/*oldState && */oldState.val === false && state.val && id.endsWith('.alive')) {
                        if (context.adapterSubs[id]) {
                            const parts = id.split('.');
                            const a = parts[2] + '.' + parts[3];
                            for (let t = 0; t < context.adapterSubs[id].length; t++) {
                                adapter.log.info('Detected coming adapter "' + a + '". Send subscribe: ' + context.adapterSubs[id][t]);
                                adapter.sendTo(a, 'subscribe', context.adapterSubs[id][t]);
                            }
                        }
                    }
                } else if (/*!oldState && */context.stateIds.indexOf(id) === -1) {
                    context.stateIds.push(id);
                    context.stateIds.sort();
                }
                context.states[id] = state;
            } else {
                if (oldState) delete context.states[id];
                state = {};
                const pos = context.stateIds.indexOf(id);
                if (pos !== -1) {
                    context.stateIds.splice(pos, 1);
                }
            }
            const _eventObj = eventObj.createEventObject(context, id, state, oldState);

            // if this state matches any subscriptions
            for (let i = 0, l = context.subscriptions.length; i < l; i++) {
                const sub = context.subscriptions[i];
                if (sub && patternMatching(_eventObj, sub.patternCompareFunctions)) {
                    sub.callback(_eventObj);
                }
            }
        },

        unload: callback => stopAllScripts(callback),

        ready: function () {
            // todo
            context.errorLogFunction = webstormDebug ? console : adapter.log;
            activeStr = adapter.namespace + '.scriptEnabled.';

            mods.fs = new require('./lib/protectFs')(adapter.log);

            // try to read TS declarations
            try {
                tsAmbient = {
                    'javascript.d.ts': nodeFS.readFileSync(mods.path.join(__dirname, 'lib/javascript.d.ts'), 'utf8')
                };
                tsServer.provideAmbientDeclarations(tsAmbient);
                jsDeclarationServer.provideAmbientDeclarations(tsAmbient);
            } catch (e) {
                adapter.log.warn('Could not read TypeScript ambient declarations: ' + e);
            }

            context.logWithLineInfo = function (level, msg) {
                if (msg === undefined) {
                    return context.logWithLineInfo('info', msg);
                }

                context.errorLogFunction && context.errorLogFunction[level](msg);

                const stack = (new Error().stack).split('\n');

                for (let i = 3; i < stack.length; i++) {
                    if (!stack[i]) continue;
                    if (stack[i].match(/runInContext|runInNewContext|javascript\.js:/)) break;
                    context.errorLogFunction && context.errorLogFunction[level](fixLineNo(stack[i]));
                }
            };

            context.logWithLineInfo.warn = context.logWithLineInfo.bind(1, 'warn');
            context.logWithLineInfo.error = context.logWithLineInfo.bind(1, 'error');
            context.logWithLineInfo.info = context.logWithLineInfo.bind(1, 'info');

            context.scheduler = new Scheduler(adapter.log);

            installLibraries(() => {

                // Load the TS declarations for Node.js and all 3rd party modules
                loadTypeScriptDeclarations();

                getData(() => {
                    adapter.subscribeForeignObjects('*');

                    if (!adapter.config.subscribe) {
                        adapter.subscribeForeignStates('*');
                    }

                    // Warning. It could have a side-effect in compact mode, so all adapters will accept self signed certificates
                    if (adapter.config.allowSelfSignedCerts) {
                        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
                    }

                    adapter.objects.getObjectView('script', 'javascript', {}, (err, doc) => {
                        globalScript = '';
                        globalDeclarations = '';
                        knownGlobalDeclarationsByScript = {};
                        let count = 0;
                        if (doc && doc.rows && doc.rows.length) {
                            // assemble global script
                            for (let g = 0; g < doc.rows.length; g++) {
                                if (checkIsGlobal(doc.rows[g].value)) {
                                    const obj = doc.rows[g].value;

                                    if (obj && obj.common.enabled) {
                                        const engineType = (obj.common.engineType || '').toLowerCase();
                                        if (engineType.startsWith('coffee')) {
                                            count++;
                                            coffeeCompiler.fromSource(obj.common.source, {
                                                sourceMap: false,
                                                bare: true
                                            }, (err, js) => {
                                                if (err) {
                                                    adapter.log.error('coffee compile ' + err);
                                                    return;
                                                }
                                                globalScript += js + '\n';
                                                if (!--count) {
                                                    globalScriptLines = globalScript.split(/\r\n|\n|\r/g).length;
                                                    // load all scripts
                                                    for (let i = 0; i < doc.rows.length; i++) {
                                                        if (!checkIsGlobal(doc.rows[i].value)) {
                                                            load(doc.rows[i].value._id);
                                                        }
                                                    }
                                                }
                                            });
                                        } else if (engineType.startsWith('typescript')) {
                                            // compile the current global script
                                            const filename = scriptIdToTSFilename(obj._id);
                                            const tsCompiled = tsServer.compile(filename, obj.common.source);

                                            const errors = tsCompiled.diagnostics.map(diag => diag.annotatedSource + '\n').join('\n');

                                            if (tsCompiled.success) {
                                                if (errors.length > 0) {
                                                    adapter.log.warn('TypeScript compilation completed with errors: \n' + errors);
                                                } else {
                                                    adapter.log.info('TypeScript compilation successful');
                                                }
                                                globalScript += tsCompiled.result + '\n';

                                                // if declarations were generated, remember them
                                                if (tsCompiled.declarations != null) {
                                                    provideDeclarationsForGlobalScript(obj._id, tsCompiled.declarations);
                                                }
                                            } else {
                                                adapter.log.error('TypeScript compilation failed: \n' + errors);
                                            }
                                        } else { // javascript
                                            const sourceCode = obj.common.source;
                                            globalScript += sourceCode + '\n';

                                            // try to compile the declarations so TypeScripts can use
                                            // functions defined in global JavaScripts
                                            const filename = scriptIdToTSFilename(obj._id);
                                            const tsCompiled = jsDeclarationServer.compile(filename, sourceCode);
                                            // if declarations were generated, remember them
                                            if (tsCompiled.success && tsCompiled.declarations != null) {
                                                provideDeclarationsForGlobalScript(obj._id, tsCompiled.declarations);
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        if (!count) {
                            globalScript = globalScript.replace(/\r\n/g, '\n');
                            globalScriptLines = globalScript.split(/\n/g).length - 1;

                            if (doc && doc.rows && doc.rows.length) {
                                // load all scripts
                                for (let i = 0; i < doc.rows.length; i++) {
                                    if (!checkIsGlobal(doc.rows[i].value)) {
                                        load(doc.rows[i].value);
                                    }
                                }
                            }
                        }

                        if (adapter.config.mirrorPath) {
                            mirror = new Mirror({
                                adapter,
                                log: adapter.log,
                                diskRoot: adapter.config.mirrorPath
                            });
                        }

                    });
                });
            });
        },

        message: obj => {
            if (obj) {
                switch (obj.command) {
                    // process messageTo commands
                    case 'jsMessageBus':
                        if (obj.message && (
                            obj.message.instance === null ||
                            obj.message.instance === undefined ||
                            ('javascript.' + obj.instance === adapter.namespace) ||
                            (obj.instance === adapter.namespace)
                        )) {
                            Object.keys(context.messageBusHandlers).forEach(name => {
                                // script name could be script.js.xxx or only xxx
                                if ((!obj.message.script || obj.message.script === name) && context.messageBusHandlers[name][obj.message.message]) {
                                    context.messageBusHandlers[name][obj.message.message].forEach(handler => {
                                        try {
                                            if (obj.callback) {
                                                handler.cb.call(handler.sandbox, obj.message.data, result =>
                                                    adapter.sendTo(obj.from, obj.command, result, obj.callback));
                                            } else {
                                                handler.cb.call(handler.sandbox, obj.message.data, result => {/* nop */ });
                                            }
                                        } catch (e) {
                                            adapter.setState('scriptProblem.' + name.substring('script.js.'.length), true, true);
                                            context.logError('Error in callback', e);
                                        }
                                    });
                                }
                            });
                        }
                        break;

                    case 'loadTypings': { // Load typings for the editor
                        const typings = {};

                        // try to load TypeScript lib files from disk
                        try {
                            const typescriptLibs = resolveTypescriptLibs(targetTsLib);
                            Object.assign(typings, typescriptLibs);
                        } catch (e) { /* ok, no lib then */ }

                        // provide the already-loaded ioBroker typings and global script declarations
                        Object.assign(typings, tsAmbient);

                        // also provide the known global declarations for each global script
                        for (const globalScriptPaths of Object.keys(knownGlobalDeclarationsByScript)) {
                            typings[globalScriptPaths + '.d.ts'] = knownGlobalDeclarationsByScript[globalScriptPaths];
                        }

                        if (obj.callback) {
                            adapter.sendTo(obj.from, obj.command, { typings }, obj.callback);
                        }
                        break;
                    }
                }
            }
        },

        /**
         * If the JS-Controller catches an unhandled error, this will be called
         * so we have a chance to handle it ourself.
         * @param {Error} err
         */
        error: (err) => {
            // Identify unhandled errors originating from callbacks in scripts
            // These are not caught by wrapping the execution code in try-catch
            const scriptCodeMarker = 'script.js.';
            if (typeof err.stack === 'string' && err.stack.indexOf(scriptCodeMarker) > -1) {
                // This is a script error
                let scriptName = err.stack.substr(err.stack.indexOf(scriptCodeMarker));
                scriptName = scriptName.substr(0, scriptName.indexOf(':'));
                context.logError(scriptName, err);
                // Leave the script running for now

                // TODO: Add a marker that the script has problems:
                // https://github.com/ioBroker/ioBroker.javascript/issues/162

                // signal to the JS-Controller that we handled the error ourselves
                return true;
            }
        }
    });
    adapter = new utils.Adapter(options);

    // handler for logs
    adapter.on('log', msg =>
        Object.keys(context.logSubscriptions)
            .forEach(name =>
                context.logSubscriptions[name].forEach(handler => {
                    if (typeof handler.cb === 'function' && (handler.severity === '*' || handler.severity === msg.severity)) {
                        handler.sandbox.logHandler = handler.severity || '*';
                        handler.cb.call(handler.sandbox, msg);
                        handler.sandbox.logHandler = null;
                    }
                })));

    context.adapter = adapter;
    return adapter;
}

function stopAllScripts(cb) {
    Object.keys(context.scripts).forEach(id => stop(id));
    setTimeout(() => cb(), 0);
}

const attempts         = {};
let globalScript       = '';
/** Generated declarations for global TypeScripts */
let globalDeclarations = '';
// Remember which definitions the global scripts
// have access to, because it depends on the compile order
let knownGlobalDeclarationsByScript = {};
let globalScriptLines  = 0;
// let activeRegEx        = null;
let activeStr          = ''; // enabled state prefix

/**
 * Redirects the virtual-tsc log output to the ioBroker log
 * @param {string} msg message
 * @param {string} sev severity (info, silly, debug, warn, error)
 */
function tsLog(msg, sev) {
    // shift the severities around, we don't care about the small details
    if (sev == null || sev === 'info') {
        sev = 'debug';
    } else if (sev === 'debug') {
        sev = 'silly';
    }

    if (adapter && adapter.log) {
        adapter.log[sev](msg);
    } else {
        console.log(`[${sev.toUpperCase()}] ${msg}`);
    }
}
// compiler instance for typescript
tsServer = new tsc.Server(tsCompilerOptions, tsLog);
// compiler instance for global JS declarations
jsDeclarationServer = new tsc.Server(jsDeclarationCompilerOptions);

function addGetProperty(object) {
    try {
        Object.defineProperty(object, 'get', {
            value: function (id) {
                return this[id] || this[adapter.namespace + '.' + id];
            },
            enumerable: false
        });
    } catch (e) {
        console.error('Cannot install get property');
    }
}

function fixLineNo(line) {
    if (line.indexOf('javascript.js:') >= 0) return line;
    if (!/script[s]?\.js[.\\\/]/.test(line)) return line;
    if (/:([\d]+):/.test(line)) {
        line = line.replace(/:([\d]+):/, ($0, $1) =>
            ':' + ($1 > globalScriptLines ? $1 - globalScriptLines : $1) + ':');
    } else {
        line = line.replace(/:([\d]+)$/, ($0, $1) =>
            ':' + ($1 > globalScriptLines ? $1 - globalScriptLines : $1));
    }
    return line;
}

context.logError = function (msg, e, offs) {
    const stack = e.stack ? e.stack.split('\n') : (e ? e.toString() : '');
    if (msg.indexOf('\n') < 0) {
        msg = msg.replace(/[: ]*$/, ': ');
    }

    //errorLogFunction.error(msg + stack[0]);
    context.errorLogFunction.error(msg + fixLineNo(stack[0]));
    for (let i = offs || 1; i < stack.length; i++) {
        if (!stack[i]) continue;
        if (stack[i].match(/runInNewContext|javascript\.js:/)) break;
        //adapter.log.error(fixLineNo(stack[i]));
        context.errorLogFunction.error(fixLineNo(stack[i]));
    }
};

function createActiveObject(id, enabled, cb) {
    const idActive = adapter.namespace + '.scriptEnabled.' + id.substring('script.js.'.length);

    if (!context.objects[idActive]) {
        context.objects[idActive] = {
            _id: idActive,
            common: {
                name: 'scriptEnabled.' + id.substring('script.js.'.length),
                desc: 'controls script activity',
                type: 'boolean',
                write: true,
                read: true,
                role: 'switch.active'
            },
            native: {
                script: id
            },
            type: 'state'
        };
        adapter.setForeignObject(idActive, context.objects[idActive], err => {
            if (!err) {
                adapter.setForeignState(idActive, enabled, true, cb);
            } else if (cb) {
                cb();
            }
        });
    } else {
        adapter.getForeignState(idActive, (err, state) => {
            if (state && state.val !== enabled) {
                adapter.setForeignState(idActive, enabled, true, cb);
            } else if (cb) {
                cb();
            }
        });
    }
}

function createProblemObject(id, cb) {
    const idProblem = adapter.namespace + '.scriptProblem.' + id.substring('script.js.'.length);

    if (!context.objects[idProblem]) {
        context.objects[idProblem] = {
            _id: idProblem,
            common: {
                name: 'scriptProblem.' + id.substring('script.js.'.length),
                desc: 'is the script has a problem',
                type: 'boolean',
                expert: true,
                write: false,
                read: true,
                role: 'indicator.error'
            },
            native: {
                script: id
            },
            type: 'state'
        };
        adapter.setForeignObject(idProblem, context.objects[idProblem], err => {
            if (!err) {
                adapter.setForeignState(idProblem, false, true, cb);
            } else if (cb) {
                cb();
            }
        });
    } else {
        adapter.getForeignState(idProblem, (err, state) => {
            if (state && state.val !== false) {
                adapter.setForeignState(idProblem, false, true, cb);
            } else if (cb) {
                cb();
            }
        });
    }
}

function addToNames(obj) {
    const id = obj._id;
    if (obj.common && obj.common.name) {
        const name = obj.common.name;
        if (typeof name !== 'string') return;

        if (!context.names[name]) {
            context.names[name] = id;
        } else {
            if (typeof context.names[name] === 'string') {
                context.names[name] = [context.names[name]];
            }
            context.names[name].push(id);
        }
    }
}

function removeFromNames(id) {
    const n = getName(id);

    if (n) {
        let pos;
        if (context.names[n] === 'object') {
            pos = context.names[n].indexOf(id);
            if (pos !== -1) {
                context.names[n].splice(pos, 1);
                if (context.names[n].length) {
                    context.names[n] = context.names[n][0];
                }
            }
        } else {
            delete context.names[n];
        }
    }
}

function getName(id) {
    let pos;
    for (const n in context.names) {
        if (context.names.hasOwnProperty(n)) {
            if (context.names[n] && typeof context.names[n] === 'object') {
                pos = context.names[n].indexOf(id);
                if (pos !== -1) return n;
            } else if (context.names[n] === id) {
                return n;
            }
        }
    }
    return null;
}

function installNpm(npmLib, callback) {
    const path = __dirname;
    if (typeof npmLib === 'function') {
        callback = npmLib;
        npmLib = undefined;
    }

    const cmd = 'npm install ' + npmLib + ' --production --prefix "' + path + '"';
    adapter.log.info(cmd + ' (System call)');
    // Install node modules as system call

    // System call used for update of js-controller itself,
    // because during installation npm packet will be deleted too, but some files must be loaded even during the install process.
    const child = mods['child_process'].exec(cmd);

    child.stdout.on('data', buf =>
        adapter.log.info(buf.toString('utf8')));

    child.stderr.on('data', buf =>
        adapter.log.error(buf.toString('utf8')));

    child.on('exit', (code /* , signal */) => {
        if (code) {
            adapter.log.error('Cannot install ' + npmLib + ': ' + code);
        }
        // command succeeded
        if (typeof callback === 'function') callback(npmLib);
    });
}

function installLibraries(callback) {
    let allInstalled = true;
    if (adapter.config && adapter.config.libraries) {
        const libraries = adapter.config.libraries.split(/[,;\s]+/);

        for (let lib = 0; lib < libraries.length; lib++) {
            if (libraries[lib] && libraries[lib].trim()) {
                libraries[lib] = libraries[lib].trim();
                if (!nodeFS.existsSync(__dirname + '/node_modules/' + libraries[lib] + '/package.json')) {

                    if (!attempts[libraries[lib]]) {
                        attempts[libraries[lib]] = 1;
                    } else {
                        attempts[libraries[lib]]++;
                    }
                    if (attempts[libraries[lib]] > 3) {
                        adapter.log.error('Cannot install npm packet: ' + libraries[lib]);
                        continue;
                    }

                    installNpm(libraries[lib], () =>
                        installLibraries(callback));

                    allInstalled = false;
                    break;
                }
            }
        }
    }
    if (allInstalled) callback();
}

function compile(source, name) {
    source += "\n;\nlog('registered ' + __engine.__subscriptions + ' subscription' + (__engine.__subscriptions === 1 ? '' : 's' ) + ' and ' + __engine.__schedules + ' schedule' + (__engine.__schedules === 1 ? '' : 's' ));\n";
    try {
        if (VMScript) {
            return {
                script: new VMScript(source, name)
            };
        } else {
            const options = {
                filename: name,
                displayErrors: true
                //lineOffset: globalScriptLines
            };
            return {
                script: vm.createScript(source, options)
            };
        }
    } catch (e) {
        context.logError(name + ' compile failed:\r\nat ', e);
        return false;
    }
}

function execute(script, name, verbose, debug) {
    script.intervals = [];
    script.timeouts = [];
    script.schedules = [];
    script.wizards = [];
    script.name = name;
    script._id = Math.floor(Math.random() * 0xFFFFFFFF);
    script.subscribes = {};
    adapter.setState('scriptProblem.' + name.substring('script.js.'.length), { val: false, ack: true, expire: 1000 });

    const sandbox = sandBox(script, name, verbose, debug, context);

    if (NodeVM) {
        const vm = new NodeVM({
            sandbox,
            require: {
                external: true,
                builtin: ['*'],
                root: '',
                mock: mods
            }
        });

        try {
            vm.run(script.script, name);
        } catch (e) {
            adapter.setState('scriptProblem.' + name.substring('script.js.'.length), true, true);
            context.logError(name, e);
        }
    } else {
        try {
            script.script.runInNewContext(sandbox, {
                filename: name,
                displayErrors: true
                //lineOffset: globalScriptLines
            });
        } catch (e) {
            adapter.setState('scriptProblem.' + name.substring('script.js.'.length), true, true);
            context.logError(name, e);
        }
    }
}

function unsubscribe(id) {
    if (!id) {
        adapter.log.warn('unsubscribe: empty name');
        return;
    }

    if (id.constructor && id.constructor.name === 'RegExp') {
        //adapter.log.warn('unsubscribe: todo - process regexp');
        return;
    }

    if (typeof id !== 'string') {
        adapter.log.error('unsubscribe: invalid type of id - ' + typeof id);
        return;
    }
    const parts = id.split('.');
    const _adapter = 'system.adapter.' + parts[0] + '.' + parts[1];
    if (context.objects[_adapter] && context.objects[_adapter].common && context.objects[_adapter].common.subscribable) {
        const a = parts[0] + '.' + parts[1];
        const alive = 'system.adapter.' + a + '.alive';
        if (context.adapterSubs[alive]) {
            const pos = context.adapterSubs[alive].indexOf(id);
            if (pos !== -1) context.adapterSubs[alive].splice(pos, 1);
            if (!context.adapterSubs[alive].length) delete context.adapterSubs[alive];
        }
        adapter.sendTo(a, 'unsubscribe', id);
    }
}

// Analyse if logs are still required or not
function updateLogSubscriptions() {
    let found = false;
    // go through all scripts and check if some one script still require logs
    Object.keys(context.logSubscriptions).forEach(name => {
        if (!context.logSubscriptions[name] || !context.logSubscriptions[name].length) {
            delete context.logSubscriptions[name];
        } else {
            found = true;
        }
    });

    if (found && !logSubscribed) {
        logSubscribed = true;
        adapter.requireLog(logSubscribed);
    } else if (!found && logSubscribed) {
        logSubscribed = false;
        adapter.requireLog(logSubscribed);
    }
}

function stop(name, callback) {
    adapter.log.info('Stop script ' + name);

    adapter.setState('scriptEnabled.' + name.substring('script.js.'.length), false, true);

    if (context.messageBusHandlers[name]) {
        delete context.messageBusHandlers[name];
    }

    if (context.logSubscriptions[name]) {
        delete context.logSubscriptions[name];
        updateLogSubscriptions();
    }

    if (context.scripts[name]) {
        // Remove from subscriptions
        context.isEnums = false;
        if (adapter.config.subscribe) {
            // check all subscribed IDs
            for (const id in context.scripts[name].subscribes) {
                if (!context.scripts[name].subscribes.hasOwnProperty(id)) continue;
                if (context.subscribedPatterns[id]) {
                    context.subscribedPatterns[id] -= context.scripts[name].subscribes[id];
                    if (context.subscribedPatterns[id] <= 0) {
                        adapter.unsubscribeForeignStates(id);
                        delete context.subscribedPatterns[id];
                        if (context.states[id]) delete context.states[id];
                    }
                }
            }
        }

        for (let i = context.subscriptions.length - 1; i >= 0; i--) {
            if (context.subscriptions[i].name === name) {
                const sub = context.subscriptions.splice(i, 1)[0];
                sub && unsubscribe(sub.pattern.id);
            } else {
                if (!context.isEnums && context.subscriptions[i].pattern.enumName || context.subscriptions[i].pattern.enumId) {
                    context.isEnums = true;
                }
            }
        }

        // Stop all timeouts
        for (let i = 0; i < context.scripts[name].timeouts.length; i++) {
            clearTimeout(context.scripts[name].timeouts[i]);
        }
        // Stop all intervals
        for (let i = 0; i < context.scripts[name].intervals.length; i++) {
            clearInterval(context.scripts[name].intervals[i]);
        }
        // Stop all scheduled jobs
        for (let i = 0; i < context.scripts[name].schedules.length; i++) {
            if (context.scripts[name].schedules[i]) {
                const _name = context.scripts[name].schedules[i].name;
                if (!nodeSchedule.cancelJob(context.scripts[name].schedules[i])) {
                    adapter.log.error('Error by canceling scheduled job "' + _name + '"');
                }
            }
        }

        // Stop all time wizards jobs
        for (let i = 0; i < context.scripts[name].wizards.length; i++) {
            if (context.scripts[name].wizards[i]) {
                context.scheduler.remove(context.scripts[name].wizards[i]);
            }
        }

        // if callback for on stop
        if (typeof context.scripts[name].onStopCb === 'function') {
            context.scripts[name].onStopTimeout = parseInt(context.scripts[name].onStopTimeout, 10) || 1000;

            let timeout = setTimeout(() => {
                if (timeout) {
                    timeout = null;
                    delete context.scripts[name];
                    if (typeof callback === 'function') callback(true, name);
                }
            }, context.scripts[name].onStopTimeout);

            try {
                context.scripts[name].onStopCb(() => {
                    if (timeout) {
                        clearTimeout(timeout);
                        timeout = null;
                        delete context.scripts[name];
                        if (typeof callback === 'function') callback(true, name);
                    }
                });
            } catch (e) {
                adapter.log.error('error in onStop callback: ' + e);
            }

        } else {
            delete context.scripts[name];
            if (typeof callback === 'function') callback(true, name);
        }
    } else {
        typeof callback === 'function' && callback(false, name);
    }
}

function prepareScript(obj, callback) {
    if (obj &&
        obj.common.enabled &&
        obj.common.engine === 'system.adapter.' + adapter.namespace &&
        obj.common.source) {
        const name = obj._id;

        adapter.setState('scriptEnabled.' + name.substring('script.js.'.length), true, true);
        obj.common.engineType = obj.common.engineType || '';

        if ((obj.common.engineType.toLowerCase().startsWith('javascript') || obj.common.engineType === 'Blockly')) {
            // Javascript
            adapter.log.info('Start javascript ' + name);

            let sourceFn = name;
            if (webstormDebug) {
                const fn = name.replace(/^script.js./, '').replace(/\./g, '/');
                sourceFn = mods.path.join(webstormDebug, fn + '.js');
            }
            context.scripts[name] = compile(globalScript + obj.common.source, sourceFn);
            context.scripts[name] && execute(context.scripts[name], sourceFn, obj.common.verbose, obj.common.debug);
            if (typeof callback === 'function') callback(true, name);
        } else if (obj.common.engineType.toLowerCase().startsWith('coffee')) {
            // CoffeeScript
            coffeeCompiler.fromSource(obj.common.source, { sourceMap: false, bare: true }, (err, js) => {
                if (err) {
                    adapter.log.error(name + ' coffee compile ' + err);
                    if (typeof callback === 'function') callback(false, name);
                    return;
                }
                adapter.log.info('Start coffescript ' + name);
                context.scripts[name] = compile(globalScript + '\n' + js, name);
                context.scripts[name] && execute(context.scripts[name], name, obj.common.verbose, obj.common.debug);
                typeof callback === 'function' && callback(true, name);
            });
        } else if (obj.common.engineType.toLowerCase().startsWith('typescript')) {
            // TypeScript
            adapter.log.info(name + ': compiling TypeScript source...');
            const filename = scriptIdToTSFilename(name);
            const tsCompiled = tsServer.compile(filename, obj.common.source);

            const errors = tsCompiled.diagnostics.map(diag => diag.annotatedSource + '\n').join('\n');

            if (tsCompiled.success) {
                if (errors.length > 0) {
                    adapter.log.warn(name + ': TypeScript compilation had errors: \n' + errors);
                } else {
                    adapter.log.info(name + ': TypeScript compilation successful');
                }
                context.scripts[name] = compile(globalScript + '\n' + tsCompiled.result, name);
                context.scripts[name] && execute(context.scripts[name], name, obj.common.verbose, obj.common.debug);
                typeof callback === 'function' && callback(true, name);
            } else {
                adapter.log.error(name + ': TypeScript compilation failed: \n' + errors);
            }
        }
    } else {
        let _name;
        if (obj && obj._id) {
            _name = obj._id;
            adapter.setState('scriptEnabled.' + _name.substring('script.js.'.length), false, true);
        }
        if (!obj) adapter.log.error('Invalid script');
        if (typeof callback === 'function') callback(false, _name);
    }
}

function load(nameOrObject, callback) {
    if (typeof nameOrObject === 'object') {
        // create states for scripts
        createActiveObject(nameOrObject._id, nameOrObject && nameOrObject.common && nameOrObject.common.enabled, () =>
            createProblemObject(nameOrObject._id, () =>
                prepareScript(nameOrObject, callback)));

    } else {
        adapter.getForeignObject(nameOrObject, (err, obj) => {
            if (!obj || err) {
                if (err) adapter.log.error('Invalid script "' + nameOrObject + '": ' + err);
                if (typeof callback === 'function') callback(false, nameOrObject);
            } else {
                return load(obj, callback);
            }
        });
    }
}

function patternMatching(event, patternFunctions) {
    let matched = false;
    for (let i = 0, len = patternFunctions.length; i < len; i++) {
        if (patternFunctions[i](event)) {
            if (patternFunctions.logic === 'or') return true;

            matched = true;
        } else if (patternFunctions.logic === 'and') {
            return false;
        }
    }
    return matched;
}

function getData(callback) {
    let statesReady;
    let objectsReady;
    adapter.log.info('requesting all states');
    adapter.getForeignStates('*', (err, res) => {
        if (!adapter.config.subscribe) {
            context.states = res;
        }

        addGetProperty(context.states);

        // remember all IDs
        for (const id in res) {
            if (res.hasOwnProperty(id)) {
                context.stateIds.push(id);
            }
        }
        statesReady = true;
        adapter.log.info('received all states');
        objectsReady && typeof callback === 'function' && callback();
    });

    adapter.log.info('requesting all objects');

    adapter.objects.getObjectList({ include_docs: true }, (err, res) => {
        res = res.rows;
        context.objects = {};
        for (let i = 0; i < res.length; i++) {
            if (!res[i].doc) {
                adapter.log.debug('Got empty object for index ' + i + ' (' + res[i].id + ')');
                continue;
            }
            context.objects[res[i].doc._id] = res[i].doc;
            res[i].doc.type === 'enum' && context.enums.push(res[i].doc._id);

            // Collect all names
            addToNames(context.objects[res[i].doc._id]);
        }
        addGetProperty(context.objects);

        const systemConfig = context.objects['system.config'];

        // set language for debug messages
        if (systemConfig && systemConfig.common && systemConfig.common.language) {
            words.setLanguage(systemConfig.common.language);
        } else if (adapter.language) {
            words.setLanguage(adapter.language);
        }

        // try to use system coordinates
        if (adapter.config.useSystemGPS) {
            if (systemConfig && systemConfig.common && systemConfig.common.latitude) {
                adapter.config.latitude = systemConfig.common.latitude;
                adapter.config.longitude = systemConfig.common.longitude;
            } else if (adapter.latitude) {
                adapter.config.latitude = adapter.latitude;
                adapter.config.longitude = adapter.longitude;
            }
        }
        adapter.config.latitude = parseFloat(adapter.config.latitude);
        adapter.config.longitude = parseFloat(adapter.config.longitude);

        objectsReady = true;
        adapter.log.info('received all objects');
        statesReady && typeof callback === 'function' && callback();
    });
}

// If started as allInOne mode => return function to create instance
if (module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}