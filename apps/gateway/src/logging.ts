import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** 仅接收经过pino脱敏的运行元数据，按UTC日轮转，不记录请求正文。 */
export class DailyLog {
  private day = '';
  constructor(private directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  write(line: string): void {
    const now = new Date(); const day = now.toISOString().slice(0, 10);
    if (this.day !== day) {
      this.day = day;
      const cutoff = now.getTime() - 14 * 86_400_000;
      for (const name of readdirSync(this.directory)) {
        const match = /^moris-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
        if (match && Date.parse(`${match[1]}T00:00:00Z`) < cutoff) unlinkSync(join(this.directory, name));
      }
    }
    appendFileSync(join(this.directory, `moris-${day}.log`), line, { mode: 0o600 });
    process.stdout.write(line);
  }
}
