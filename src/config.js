import {createChannelConfig} from '@dot-bridge/core/channels';
import {channel} from './channel.js';
export const readConfig=(env=process.env)=>createChannelConfig(channel,env);
