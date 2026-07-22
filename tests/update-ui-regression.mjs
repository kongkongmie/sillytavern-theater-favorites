import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const updates = JSON.parse(fs.readFileSync(new URL('../updates.json', import.meta.url), 'utf8'));

assert.equal(updates.latest, manifest.version, 'updates.json latest must match manifest version');
assert.ok(updates.releases.some(release => release.version === manifest.version), 'current release notes must exist');
assert.match(source, /updates-toggle[^\n]+addEventListener\('click', toggleUpdatesPage\)/, 'update page must start from a user action');
assert.match(source, /function toggleUpdatesPage\(\)[\s\S]*?setPanelView\(opening \? 'updates' : 'list'\)/, 'pressing update twice must return to the list');
assert.match(source, /function toggleSettingsPage\(\)[\s\S]*?setPanelView\(opening \? 'settings' : 'list'\)/, 'pressing settings twice must return to the list');
assert.match(source, /function toggleTagManager\(\)[\s\S]*?classList\.contains\('tag-manager-open'\)[\s\S]*?setPanelView\('list'\)/, 'pressing tags twice must return to the list');
assert.match(source, /function setPanelView\(view = 'list'\)/, 'subpages must share one exclusive view controller');
assert.doesNotMatch(source, /setInterval\([^\n]*(?:checkForExtensionUpdates|installExtensionUpdate)/, 'updates must never be polled');
assert.match(source, /if \(state\.updateHintChecked\) return;/, 'the unobtrusive update hint must check at most once per page session');
assert.match(source, /renderUpdateHint\(available, latest\)/, 'an available update must change the toolbar button');
assert.match(source, /window\.confirm\(`更新到/, 'installing an update must require confirmation');
assert.doesNotMatch(source, /theater-play\.png[^\n]*(?:innerHTML|reliableIconMarkup)/, 'critical UI icons must not use the image asset');
assert.match(source, /fa-masks-theater/, 'critical UI icons must use SillyTavern Font Awesome');
assert.match(styles, /Final theme firewall:[\s\S]*-webkit-text-fill-color: #eee9df !important;/, 'theme firewall must fix text fill color');

console.log('update UI regression: ok');
