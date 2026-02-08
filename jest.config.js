export default {
	testEnvironment: 'node',
	testMatch: ['**/dist/**/*.test.js', '**/dist/**/?(*.)+(spec|test).js'],
	collectCoverageFrom: [
		'dist/**/*.js',
		'!dist/**/*.d.ts',
		'!dist/index.js',
	],
	coverageDirectory: 'coverage',
	coverageReporters: ['text', 'lcov', 'html'],
	moduleDirectories: ['node_modules', '<rootDir>/dist'],
	testTimeout: 30000,
	transform: {}
}
