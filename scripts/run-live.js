import {runChannel} from '@dot-bridge/core/channels';
import {channel} from '../src/channel.js';
if(process.argv.length!==3||process.argv[2]!=='--confirm-live'){process.stdout.write('Live startup requires --confirm-live. No private files read.\n');}
else{const {createProvider}=await import('../src/provider.js');await runChannel({channel,createProvider},{mode:'live'});}
