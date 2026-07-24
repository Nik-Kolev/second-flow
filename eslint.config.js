import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		languageOptions: {
			globals: globals.node,
		},
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
			],
		},
	},
	{
		files: ['public/**/*.js'],
		languageOptions: {
			globals: globals.browser,
		},
	},
	{
		ignores: ['dist/', 'src/generated/'],
	},
);
