import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
let count=0;for(const dir of ['src','scripts','test'])for(const file of fs.readdirSync(dir,{recursive:true}).filter(f=>f.endsWith('.js'))){const r=spawnSync(process.execPath,['--check',path.join(dir,file)],{encoding:'utf8',windowsHide:true});if(r.status!==0){process.stderr.write(r.stderr);process.exit(1);}count++;}console.log(`Checked ${count} JavaScript files.`);

const release=JSON.parse(fs.readFileSync('vendor/core-release.json','utf8'));
const core=JSON.parse(fs.readFileSync('node_modules/@dot-bridge/core/package.json','utf8'));
const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8'));
const artifact=fs.readFileSync(`vendor/dot-bridge-core-${release.version}.tgz`);
if(release.package!=='@dot-bridge/core'||core.version!==release.version||!/^[a-f0-9]{40}$/.test(release.source_revision)||createHash('sha256').update(artifact).digest('hex')!==release.sha256||lock.packages['node_modules/@dot-bridge/core'].integrity!=='sha512-'+createHash('sha512').update(artifact).digest('base64'))throw Error('Core release integrity differs');
console.log('Verified pinned core source and artifact integrity.');
