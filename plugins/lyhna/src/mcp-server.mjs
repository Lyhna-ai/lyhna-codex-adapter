import { createInterface } from 'node:readline';
import { createService, toolDefinitions } from './service.mjs';

const service = createService();

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function validate(tool, args) {
  const schema = tool.inputSchema;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Object.assign(new Error('INVALID_ARGUMENTS'), { code: 'INVALID_ARGUMENTS' });
  for (const key of schema.required || []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') throw Object.assign(new Error(`MISSING_ARGUMENT: ${key}`), { code: 'INVALID_ARGUMENTS' });
  }
  const unknown = Object.keys(args).find((key) => !Object.hasOwn(schema.properties, key));
  if (unknown) throw Object.assign(new Error(`UNKNOWN_ARGUMENT: ${unknown}`), { code: 'INVALID_ARGUMENTS' });
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    const validType = property.type === 'string' ? typeof value === 'string'
      : property.type === 'integer' ? Number.isInteger(value)
        : property.type === 'boolean' ? typeof value === 'boolean'
          : property.type === 'array' ? Array.isArray(value)
            : property.type === 'object' ? value && typeof value === 'object' && !Array.isArray(value)
              : true;
    if (!validType) throw Object.assign(new Error(`INVALID_TYPE: ${key}`), { code: 'INVALID_ARGUMENTS' });
    if (property.enum && !property.enum.includes(value)) throw Object.assign(new Error(`INVALID_ENUM: ${key}`), { code: 'INVALID_ARGUMENTS' });
    if (property.minimum !== undefined && value < property.minimum) throw Object.assign(new Error(`BELOW_MINIMUM: ${key}`), { code: 'INVALID_ARGUMENTS' });
    if (property.type === 'array' && property.items?.type === 'string' && value.some((item) => typeof item !== 'string')) {
      throw Object.assign(new Error(`INVALID_ITEM_TYPE: ${key}`), { code: 'INVALID_ARGUMENTS' });
    }
  }
}

async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion || '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'lyhna-codex-adapter', version: '0.1.17' }
      }
    };
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: toolDefinitions } };
  if (method === 'tools/call') {
    const tool = toolDefinitions.find((item) => item.name === params.name);
    if (!tool) throw Object.assign(new Error(`UNKNOWN_TOOL: ${params.name}`), { code: 'UNKNOWN_TOOL' });
    validate(tool, params.arguments || {});
    const result = await service.call(params.name, params.arguments || {});
    const structuredContent = result && typeof result === 'object' && !Array.isArray(result) ? result : { result };
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent,
        isError: false
      }
    };
  }
  throw Object.assign(new Error(`METHOD_NOT_FOUND: ${method}`), { code: 'METHOD_NOT_FOUND' });
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
    const response = await handle(message);
    if (response) write(response);
  } catch (error) {
    if (message?.id !== undefined) {
      write({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32602,
          message: error.code || 'REQUEST_FAILED',
          data: { detail: String(error.message || error).slice(0, 500) }
        }
      });
    }
  }
});
