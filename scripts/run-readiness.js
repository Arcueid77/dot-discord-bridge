import {runChannel} from '@dot-bridge/core/channels';
import {channel} from '../src/channel.js';
await runChannel({channel},{mode:'readiness'});
