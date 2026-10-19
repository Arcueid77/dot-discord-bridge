import {createChannelAdapter} from '@dot-bridge/core/channels';
import {channel} from './channel.js';
export const adapter=createChannelAdapter(channel);
export default adapter;
