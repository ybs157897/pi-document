export type NaturalIntentOperation =
  | 'knowledge_base.create'
  | 'knowledge_base.list'
  | 'document.save'
  | 'document.search'
  | 'document.get'
  | 'document.list'
  | 'document.update'
  | 'document.delete';

type WriteOperation = 'knowledge_base.create' | 'document.save' | 'document.update' | 'document.delete';

const explicitWritePatterns: Record<WriteOperation, RegExp> = {
  'knowledge_base.create': /创建.{0,20}知识库|新建.{0,20}知识库|create.{0,30}knowledge base/iu,
  'document.save': /保存|存入|上传|写入|收录|\bsave\b|\bstore\b|\bupload\b/iu,
  'document.update': /更新|修改|替换|\bupdate\b|\bmodify\b|\breplace\b/iu,
  'document.delete': /删除|移除|清除|\bdelete\b|\bremove\b|\berase\b/iu,
};

const leadingReadOnlyPatterns = [
  /^(?:please\s+)?(?:(?:i\s+)?(?:only|just)\s+(?:want\s+to\s+)?read\b|read[- ]only\b)/iu,
  /^(?:请\s*)?(?:我)?(?:只|仅)(?:想|要|能|需)?(?:读|读取|阅读|查看|浏览|检索|搜索)/u,
  /^(?:只读|仅读)(?:模式)?/u,
];

const clauseBoundary = /[,，;；.!?。！？\n]|\b(?:but|however|instead|rather)\b|(?:但是|不过|而是|但)/giu;
const chineseNegationAtEnd = /(?:不(?:要|想|希望|应|必|可|得|能|需要|允许)?|别|请勿|勿|禁止|拒绝)(?:[^，,。；;.!?！？\n]{0,20})$/u;
const englishNegationAtEnd = /(?:\b(?:do\s+not|does\s+not|did\s+not|don't|doesn't|didn't|never|avoid|without|cannot|can't|should\s+not|shouldn't|must\s+not|mustn't|not)\b)(?:\s+[\p{L}\p{N}_'-]+){0,5}\s*$/iu;

/** Keep the established boundary: intent is only read from the user's leading clause. */
export function userIntentText(value: string): string {
  return value.split(/[:：\n]/, 1)[0]!
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’|「[^」]*」/g, ' ');
}

function clausePrefix(text: string, end: number): string {
  const prefix = text.slice(0, end);
  let start = 0;
  for (const match of prefix.matchAll(clauseBoundary)) start = match.index! + match[0].length;
  return prefix.slice(start).trim();
}

function isNegated(text: string, actionStart: number): boolean {
  const prefix = clausePrefix(text, actionStart);
  if (!prefix) return false;
  // "not only delete" is affirmative; other uncertain negated constructions fail closed.
  if (/\b(?:do|does|did)\s+not\s+only\b/iu.test(prefix)) return false;
  if (/^(?:不只是|不单是|不止是)/u.test(prefix)) return false;
  return chineseNegationAtEnd.test(prefix) || englishNegationAtEnd.test(prefix);
}

function hasReadOnlyPrefixBefore(text: string, actionStart: number): boolean {
  const prefix = text.slice(0, actionStart).trim();
  return leadingReadOnlyPatterns.some(pattern => pattern.test(prefix));
}

/**
 * Reports affirmative user intent only for write operations. Read operations return false so
 * their existing caller path remains unchanged. A negated operation or read-only preface never
 * authorizes a model-proposed write; a later read instruction does not erase an earlier write.
 */
export function containsExplicitWriteIntent(operation: NaturalIntentOperation | string, value: string): boolean {
  if (!['knowledge_base.create', 'document.save', 'document.update', 'document.delete'].includes(operation)) return false;
  const pattern = explicitWritePatterns[operation as WriteOperation];
  const text = userIntentText(value);
  const matches = new RegExp(pattern.source, `${pattern.flags}g`);
  for (const match of text.matchAll(matches)) {
    const start = match.index!;
    if (isNegated(text, start) || hasReadOnlyPrefixBefore(text, start)) continue;
    return true;
  }
  return false;
}
