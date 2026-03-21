import { connect, disconnect, getStatus } from '../auth/auth-ai.js';
import { analyzeLoads } from './analyze.js';
import { chat } from './chat.js';

const AIBlock = {
  connect,
  disconnect,
  getStatus,
  analyzeLoads,
  chat
};

export default AIBlock;
