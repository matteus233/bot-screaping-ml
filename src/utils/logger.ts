// src/utils/logger.ts — Logger centralizado com Winston
import winston from "winston";
import fs from "fs";
import { config } from "../config.ts";

const logDir = "./data";
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const { combine, timestamp, colorize, printf, errors } = winston.format;

const prettyFormat = printf(({ level, message, timestamp: ts, stack }) => {
  return `${ts} [${level}] ${stack ?? message}`;
});

export const logger = winston.createLogger({
  level: config.logLevel,
  format: combine(errors({ stack: true }), timestamp({ format: "YYYY-MM-DD HH:mm:ss" })),
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), prettyFormat),
    }),
    new winston.transports.File({
      filename: `${logDir}/bot.log`,
      format: prettyFormat,
      maxsize: 5 * 1024 * 1024, // 5 MB
      maxFiles: 3,
    }),
  ],
});