export interface HarnessCommand {
  name: string;
  description: string;
  inputHint?: string;
}

export function slashCommand(text: string) {
  return /^\/([\p{L}\p{N}_:.\-]+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
}

export function slashPrefix(text: string) {
  return /^\/([\p{L}\p{N}_:.\-]*)$/u.exec(text)?.[1];
}
