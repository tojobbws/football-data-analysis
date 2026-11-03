// Join every clip of the day (c0 opening, c1..cN matches) into one vertical film with one audio track.
// usage: node join.cjs [YYYY-MM-DD]  -> days/<date>/final/<date>_daily-spotlight.mp4 + contact.png
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { dateArg, dayDir, readJson } = require('./lib.cjs');

const date = dateArg();
const dir = dayDir(date);
const out = path.join(dir, 'out');
const keys = fs.readdirSync(out).filter((k) => /^c\d+$/.test(k)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
fs.writeFileSync(path.join(out, 'parts.txt'), keys.map((k) => `file '${k}/video.mp4'`).join('\n') + '\n');
const ins = [], filt = [];
keys.forEach((k, i) => {
  const tl = readJson(path.join(out, k, 'timeline.json'));
  ins.push('-i', path.join(out, k, 'mix.wav'));
  filt.push(`[${i}:a]atrim=0:${(tl.frames / 30).toFixed(4)},asetpts=PTS-STARTPTS[a${i}]`);
});
const mix = path.join(out, 'combo_mix.wav');
execFileSync('ffmpeg', ['-v', 'error', '-y', ...ins, '-filter_complex', filt.join(';') + ';' + keys.map((_, i) => `[a${i}]`).join('') + `concat=n=${keys.length}:v=0:a=1[a]`, '-map', '[a]', '-ar', '48000', mix]);
fs.mkdirSync(path.join(dir, 'final'), { recursive: true });
const film = path.join(dir, 'final', `${date}_daily-spotlight.mp4`);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(out, 'parts.txt'), '-i', mix, '-map', '0:v', '-map', '1:a',
  '-vf', 'scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-r', '30', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-shortest', '-movflags', '+faststart', film]);
const dur = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', film], { encoding: 'utf8' }).stdout.trim();
const loud = spawnSync('ffmpeg', ['-hide_banner', '-i', film, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.split('\n').filter((l) => /^\s+(I|Peak):/.test(l)).slice(-2).map((l) => l.trim()).join(' · ');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', film, '-vf', 'fps=1,scale=180:-1,tile=10x7', '-frames:v', '1', path.join(dir, 'final', 'contact.png')]);
console.log(`${film}\n${Number(dur).toFixed(1)} s · ${loud}\ncontact sheet: ${path.join(dir, 'final', 'contact.png')}`);
