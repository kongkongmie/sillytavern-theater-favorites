#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 'theater-favorites';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function exists(filePath) {
    return fs.existsSync(filePath);
}

function isSillyTavernRoot(directory) {
    return exists(path.join(directory, 'package.json'))
        && exists(path.join(directory, 'public', 'scripts', 'extensions'))
        && exists(path.join(directory, 'plugins'));
}

function findSillyTavernRoot(startDirectory) {
    let directory = path.resolve(startDirectory);
    while (true) {
        if (isSillyTavernRoot(directory)) return directory;
        const parent = path.dirname(directory);
        if (parent === directory) return null;
        directory = parent;
    }
}

function timestamp() {
    return new Date().toISOString().replace(/\D/g, '').slice(0, 14);
}

function copyDirectory(source, target) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const sourcePath = path.join(source, entry.name);
        const targetPath = path.join(target, entry.name);
        if (entry.isDirectory()) copyDirectory(sourcePath, targetPath);
        if (entry.isFile()) fs.copyFileSync(sourcePath, targetPath);
    }
}

function availablePath(preferredPath) {
    if (!exists(preferredPath)) return preferredPath;
    for (let suffix = 2; suffix < 1000; suffix += 1) {
        const candidate = `${preferredPath}-${suffix}`;
        if (!exists(candidate)) return candidate;
    }
    throw new Error(`无法创建不重复的备份路径：${preferredPath}`);
}

function availableFilePath(preferredPath) {
    if (!exists(preferredPath)) return preferredPath;
    const parsed = path.parse(preferredPath);
    for (let suffix = 2; suffix < 1000; suffix += 1) {
        const candidate = path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
        if (!exists(candidate)) return candidate;
    }
    throw new Error(`无法创建不重复的备份文件：${preferredPath}`);
}

function getBackupDirectory(rootDirectory) {
    const backupDirectory = path.join(rootDirectory, 'backups', PLUGIN_ID);
    fs.mkdirSync(backupDirectory, { recursive: true });
    return backupDirectory;
}

function migrateLegacyPluginBackups(rootDirectory, backupDirectory) {
    const pluginsDirectory = path.join(rootDirectory, 'plugins');
    const prefix = `${PLUGIN_ID}.backup-`;
    let migrated = 0;
    for (const entry of fs.readdirSync(pluginsDirectory, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
        const source = path.join(pluginsDirectory, entry.name);
        const target = availablePath(path.join(backupDirectory, entry.name));
        fs.renameSync(source, target);
        migrated += 1;
        console.log(`[小剧场收藏夹] 已迁移旧后端备份：${target}`);
    }
    return migrated;
}

function migrateLegacyConfigBackups(rootDirectory, backupDirectory) {
    const prefix = `config.yaml.backup-before-${PLUGIN_ID}-`;
    let migrated = 0;
    for (const entry of fs.readdirSync(rootDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
        const source = path.join(rootDirectory, entry.name);
        const target = availableFilePath(path.join(backupDirectory, entry.name));
        fs.renameSync(source, target);
        migrated += 1;
        console.log(`[小剧场收藏夹] 已迁移旧配置备份：${target}`);
    }
    return migrated;
}

function addGitBoundary(pluginDirectory) {
    // SillyTavern checks every plugins/* directory with Git. This copied plugin
    // is not an independent repository, so prevent Git from walking upward and
    // mistaking the parent SillyTavern repository for this plugin's repository.
    fs.writeFileSync(path.join(pluginDirectory, '.git'), 'gitdir: .git-disabled\n', 'utf8');
}

function installServerPlugin(rootDirectory) {
    const source = path.join(__dirname, 'server-plugin', PLUGIN_ID);
    const target = path.join(rootDirectory, 'plugins', PLUGIN_ID);
    const backupDirectory = getBackupDirectory(rootDirectory);
    if (!exists(source)) throw new Error(`找不到后端插件：${source}`);

    migrateLegacyPluginBackups(rootDirectory, backupDirectory);
    migrateLegacyConfigBackups(rootDirectory, backupDirectory);

    const staging = availablePath(path.join(backupDirectory, `.installing-${timestamp()}`));
    let backup = null;
    try {
        copyDirectory(source, staging);
        addGitBoundary(staging);

        if (exists(target)) {
            backup = availablePath(path.join(backupDirectory, `server-plugin-${timestamp()}`));
            fs.renameSync(target, backup);
            console.log(`[小剧场收藏夹] 已备份旧后端：${backup}`);
        }

        fs.renameSync(staging, target);
    } catch (error) {
        fs.rmSync(staging, { recursive: true, force: true });
        if (backup && exists(backup) && !exists(target)) fs.renameSync(backup, target);
        throw error;
    }

    console.log(`[小剧场收藏夹] 已安装后端：${target}`);
    console.log('[小剧场收藏夹] 已隔离复制式插件的 Git 自动更新检查。');
}

function enableServerPlugins(rootDirectory) {
    const configPath = path.join(rootDirectory, 'config.yaml');
    if (!exists(configPath)) throw new Error(`找不到 config.yaml：${configPath}`);

    const original = fs.readFileSync(configPath, 'utf8');
    const backup = availableFilePath(path.join(getBackupDirectory(rootDirectory), `config-${timestamp()}.yaml`));
    fs.copyFileSync(configPath, backup);

    let next = original;
    if (/^enableServerPlugins\s*:/m.test(next)) {
        next = next.replace(/^enableServerPlugins\s*:\s*.*$/m, 'enableServerPlugins: true');
    } else {
        next = `${next.replace(/\s*$/, '')}\n\n# Required by Theater Favorites\nenableServerPlugins: true\n`;
    }

    if (next !== original) fs.writeFileSync(configPath, next, 'utf8');
    console.log(`[小剧场收藏夹] 已开启后端插件功能，并备份 config.yaml：${backup}`);
}

try {
    const rootDirectory = process.argv[2]
        ? path.resolve(process.argv[2])
        : findSillyTavernRoot(__dirname);

    if (!rootDirectory || !isSillyTavernRoot(rootDirectory)) {
        throw new Error('没有找到 SillyTavern。请确认本文件位于酒馆已安装的小剧场收藏夹扩展目录中，或在命令后手动传入 SillyTavern 根目录。');
    }

    console.log(`[小剧场收藏夹] 找到 SillyTavern：${rootDirectory}`);
    installServerPlugin(rootDirectory);
    enableServerPlugins(rootDirectory);
    console.log('\n安装完成！请重启 SillyTavern，然后刷新浏览器。');
} catch (error) {
    console.error(`\n安装失败：${error.message || error}`);
    process.exitCode = 1;
}
