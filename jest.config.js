// jest.config.js — Configuration Jest pour SUPERCOACH
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.js', '**/*.test.js'],
  testTimeout: 10000,
  verbose: true,
  collectCoverageFrom: ['engine.js', 'server.js'],
  coverageThreshold: {
    global: { statements: 70, branches: 65, functions: 70, lines: 70 },
  },
};
