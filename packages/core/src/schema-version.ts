export const schemaVersion = 1 as const;

export const sessionIdPattern = /^ses_[A-Za-z0-9_]+$/;
export const turnIdPattern = /^trn_[A-Za-z0-9_]+$/;
export const callIdPattern = /^call_[A-Za-z0-9_]+$/;
export const utcTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export const toolNamePattern = /^[a-z][a-z0-9_]*$/;
export const maxInlineToolTextBytes = 32768;
