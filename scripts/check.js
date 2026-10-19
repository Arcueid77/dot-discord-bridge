import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
let count=0;for(const dir of ['src','scripts','test'])for(const file of fs.readdirSync(dir,{recursive:true}).filter(f=>f.endsWith('.js'))){const r=spawnSync(process.execPath,['--check',path.join(dir,file)],{encoding:'utf8',windowsHide:true});if(r.status!==0){process.stderr.write(r.stderr);process.exit(1);}count++;}console.log(`Checked ${count} JavaScript files.`);
