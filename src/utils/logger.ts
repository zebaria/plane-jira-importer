/**
 * Lightweight, coloured console logger built on chalk.
 *
 * Provides a single `log` object with semantic methods for consistent
 * output across the CLI.
 */

import chalk from 'chalk';

export interface Logger {
  info: (msg: string) => void;
  success: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  dim: (msg: string) => void;
  heading: (msg: string) => void;
  item: (msg: string) => void;
}

export const log: Logger = {
  info: (msg: string) => console.log(chalk.blue('ℹ'), msg),
  success: (msg: string) => console.log(chalk.green('✓'), msg),
  warn: (msg: string) => console.log(chalk.yellow('⚠'), msg),
  error: (msg: string) => console.error(chalk.red('✗'), msg),
  dim: (msg: string) => console.log(chalk.dim(msg)),
  heading: (msg: string) => console.log('\n' + chalk.bold.underline(msg)),
  item: (msg: string) => console.log(chalk.dim('  •'), msg),
};
