/**
 * @author NTKhang & Modded for Telegram by frnAlt & Gtajisan
 * ! GoatBot V2 Main Logic & Bot Orchestration
 */

const log = require("./logger/log.js");

// Le bot est-il complètement démarré ? (sert à ne pas planter pour une erreur de commande)
let booted = false;

// Handle runtime process exceptions cleanly
process.on("unhandledRejection", (error) => {
        log.error("UNHANDLED_REJECTION", error?.message || error);
});

process.on("uncaughtException", (error) => {
        log.error("UNCAUGHT_EXCEPTION", error?.message || error);
        log.error("UNCAUGHT_EXCEPTION", error?.stack || "No stack trace");
        // Au démarrage : on quitte (config cassée, etc.). Une fois démarré : on reste en vie.
        if (!booted) setTimeout(() => process.exit(1), 1000);
});

const path = require("path");
const fs = require("fs-extra");
const TTLMap = require("./func/TTLMap.js");
const utils = require("./utils.js");
global.utils = utils;

// Universal module resolver for aliases and TypeScript/ESM transpilation
require("./func/moduleResolver.js");

const dirConfig = path.normalize(`${__dirname}/config.json`);
const dirConfigCommands = path.normalize(`${__dirname}/configCommands.json`);

if (!fs.existsSync(dirConfig)) {
        log.error("CONFIG", "config.json not found!");
        process.exit(1);
}

// Lecture de config.json avec message d'erreur clair (ligne/colonne du problème)
function readJSONFile(file, fallback) {
        if (!fs.existsSync(file)) return fallback;
        const raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
        try {
                return JSON.parse(raw);
        } catch (e) {
                const m = /position (\d+)/.exec(e.message);
                if (m) {
                        const pos = Number(m[1]);
                        const before = raw.slice(0, pos);
                        const line = before.split("\n").length;
                        const col = pos - before.lastIndexOf("\n");
                        const bad = raw[pos] !== undefined ? JSON.stringify(raw[pos]) : "fin de fichier";
                        log.error("CONFIG", `${path.basename(file)} invalide : ${e.message} → ligne ${line}, colonne ${col}, caractère ${bad}`);
                } else {
                        log.error("CONFIG", `${path.basename(file)} invalide : ${e.message}`);
                }
                process.exit(1);
        }
}

const config = readJSONFile(dirConfig);
const configCommands = readJSONFile(dirConfigCommands, { envGlobal: {}, envCommands: {}, envEvents: {} });

// Setup global GoatBot object
global.GoatBot = {
        startTime: Date.now(),
        commands: new Map(),
        eventCommands: new Map(),
        aliases: new Map(),
        onChat: [],
        onEvent: [],
        onAnyEvent: [],
        onFirstChat: [],
        onReply: new TTLMap({ ttl: 30 * 60 * 1000, maxSize: 500, cleanupInterval: 60000 }),
        onReaction: new TTLMap({ ttl: 30 * 60 * 1000, maxSize: 500, cleanupInterval: 60000 }),
        commandFilesPath: [],
        eventCommandsFilesPath: [],
        config,
        configCommands,
        envCommands: configCommands.envCommands || {},
        envEvents: configCommands.envEvents || {},
        envGlobal: configCommands.envGlobal || {},
        botID: null,
        botInfo: null
};

// Aliases for multi-engine compatibility
global.FloppaBot = global.GoatBot;
global.Cassidy = global.GoatBot;

global.db = {
        allThreadData: [],
        allUserData: [],
        allDashBoardData: [],
        allGlobalData: [],
        threadsData: {
                get: async (id) => ({ threadID: id }),
                getAll: async () => []
        },
        usersData: {
                get: async (id) => ({ userID: id }),
                getAll: async () => []
        },
        dashBoardData: {
                get: async () => ({}),
                getAll: async () => []
        }
};

global.client = {
        dirConfig,
        dirConfigCommands,
        countDown: {},
        cache: {},
        database: {
                creatingThreadData: [],
                creatingUserData: [],
                creatingDashBoardData: [],
                creatingGlobalData: []
        }
};

// Memory Manager for 512MB RAM constraints (Render/Railway)
class MemoryManager {
        constructor(options = {}) {
                this.options = {
                        checkInterval: 3 * 60 * 1000,
                        heapThreshold: 350 * 1024 * 1024,
                        ...options
                };
                this._startMonitoring();
        }

        _startMonitoring() {
                setInterval(() => this._checkMemory(), this.options.checkInterval);
        }

        _checkMemory() {
                const memUsage = process.memoryUsage();
                if (memUsage.heapUsed > this.options.heapThreshold) {
                        log.warn("MEMORY", `Memory high: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB heap used. Cleaning up...`);
                        if (global.gc) {
                                global.gc();
                        }
                }
        }
}
const memoryManager = new MemoryManager();

// Main Execution Async Function
(async () => {
        try {
                log.info("SYSTEM", "Starting GrammChatBot Telegram Engine...");

                // 1. Initialize Auto Cleanup Cron Job (every 30 minutes)
                const { initAutoCleanup } = require("./bot/cron/autoCleanup.js");
                initAutoCleanup(config);

                // Initialize Database Controllers
                const initDB = require("./database/controller/index.js");
                await initDB(null);

                // Compatibilité style Cassidy : getCache, getItem, setItem, queryItem...
                // (corrige "threadsDB.getCache is not a function" dans une vingtaine de commandes)
                require("./database/compat/cassidyCompat.js")(global.db);

                // 2. Load Commands and Events
                const loadScripts = require("./bot/login/loadScripts.js");
                await loadScripts(global.db);

                // 3. Initialize Telegram Token Manager & Start Polling
                const tokenManager = require("./bot/telegram/tokenManager.js");
                tokenManager.init(config.telegramTokens);

                const { handleTelegramEvent } = require("./bot.js");

                const bot = await tokenManager.createBotInstance((botInstance) => {
                        botInstance.on("message", (ctx) => handleTelegramEvent(ctx));
                        botInstance.on("edited_message", (ctx) => handleTelegramEvent(ctx));
                        botInstance.on("callback_query", (ctx) => handleTelegramEvent(ctx));
                });

                if (bot) {
                        tokenManager.startPolling(bot);
                } else {
                        log.warn("SYSTEM", "Bot instance could not be started. Check telegramTokens in config.json.");
                }

                // 4. Start Express Web Dashboard
                // (écoute sur process.env.PORT : nécessaire pour que Render détecte le service)
                if (config.dashBoard?.enable !== false) {
                        try {
                                const startDashboard = require("./dashboard/app.js");
                                await startDashboard(tokenManager);
                        } catch (e) {
                                log.error("DASHBOARD", `Failed to start Web Dashboard: ${e.message}`);
                        }
                }

                booted = true;

        } catch (err) {
                log.error("FATAL_START", `Error starting GoatBot: ${err.stack || err.message}`);
        }
})();
                                
