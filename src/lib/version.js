'use strict';
// Welche Version läuft gerade? (Git-Stand beim Start, z. B. „e320927 Musik: yt-dlp …“)
const { execFileSync } = require('child_process');
let v = null;
try { v = execFileSync('git', ['log', '-1', '--format=%h %s'], { cwd: __dirname, encoding: 'utf8', timeout: 3000 }).trim(); } catch { /* kein Git */ }
module.exports = v || process.env.RENDER_GIT_COMMIT?.slice(0, 7) || 'unbekannt';
