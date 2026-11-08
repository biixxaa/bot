const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const configuredLevel = process.env.LOG_LEVEL || 'info';
const minimumLevel = levels[configuredLevel] ?? levels.info;

function write(level, message, details) {
  if (levels[level] > minimumLevel) return;
  const record = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(details ? { details } : {})
  };
  const output = JSON.stringify(record);
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.log(output);
}

module.exports = {
  error: (message, details) => write('error', message, details),
  warn: (message, details) => write('warn', message, details),
  info: (message, details) => write('info', message, details),
  debug: (message, details) => write('debug', message, details)
};
