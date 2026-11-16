import {createChannelConfig} from '@dot-bridge/core/channels';
import {channel} from './channel.js';
export const readConfig=(env=process.env)=>{
  const mode=env.DISCORD_NATIVE_VOICE??'disabled';
  if(!['enabled','disabled'].includes(mode))throw new Error('DISCORD_NATIVE_VOICE must be enabled or disabled.');
  return {...createChannelConfig(channel,env),nativeVoice:mode==='enabled'};
};
