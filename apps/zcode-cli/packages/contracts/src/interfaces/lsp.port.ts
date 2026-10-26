/**
 * LSP 语义工具端口(spec 151)。源头思路参考 Charm Crush(FSL-1.1-MIT,只借鉴不搬码)。
 *
 * 坐标契约:对外一律 1-based(line/character 从 1 起)——模型对 0-based 极易错位;
 * adapter 负责与 LSP 0-based 的往返转换。
 */

export interface LspLocation {
  /** 归一化的绝对路径。 */
  path: string;
  /** 1-based 起始行。 */
  line: number;
  /** 1-based 起始列。 */
  character: number;
  endLine?: number;
  endCharacter?: number;
}

export interface LspDefinitionRequest {
  languageId: string;
  /** 绝对路径(adapter 读盘做 didOpen;权威内容=磁盘)。 */
  filePath: string;
  /** 1-based。 */
  line: number;
  /** 1-based。 */
  character: number;
}

/** references / call-hierarchy 的定位入参与 definition 同构。 */
export type LspSymbolPositionRequest = LspDefinitionRequest;

export type LspReferencesRequest = LspSymbolPositionRequest & {
  includeDeclaration?: boolean;
};

/** rename 的附加入参:目标符号名(rename 需审批+写路径,由工具层把关)。 */
export interface LspRenameRequest extends LspSymbolPositionRequest {
  newName: string;
}

export type LspCallHierarchyDirection = "incoming" | "outgoing";

export interface LspCallHierarchyRequest extends LspSymbolPositionRequest {
  direction: LspCallHierarchyDirection;
}

/** 被调用方/调用方符号(位置=符号声明处,1-based)。 */
export interface LspCallHierarchyItem {
  name: string;
  path: string;
  line: number;
  character: number;
}

/** incoming 的 from / outgoing 的 to,加调用点位置列表。 */
export interface LspCallHierarchyCall {
  item: LspCallHierarchyItem;
  sites: LspLocation[];
}

/** LSP TextEdit 的 1-based 归一化形态(newText 替换闭区间范围)。 */
export interface LspTextEdit {
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  newText: string;
}

export interface LspFileEdit {
  path: string;
  edits: LspTextEdit[];
}

export interface LspRenameResult {
  symbolName: string;
  files: LspFileEdit[];
}

export interface LspPort {
  /** 已配置 server 的语言 id 清单(注册门的判据;空数组=功能整体不注册)。 */
  availableLanguages(): readonly string[];
  definition(request: LspDefinitionRequest): Promise<LspLocation[]>;
  /** 符号的全部引用;includeDeclaration=false 时不含声明处。 */
  references(request: LspSymbolPositionRequest & { includeDeclaration?: boolean }): Promise<LspLocation[]>;
  /** 调用层级:direction=incoming 返回调用方,outgoing 返回被调用方。 */
  callHierarchy(request: LspCallHierarchyRequest): Promise<LspCallHierarchyCall[]>;
  /** 语义 rename:返回跨文件编辑计划(工具层审批后应用)。 */
  rename(request: LspRenameRequest): Promise<LspRenameResult>;
  /** 预热:对已配置语言预启动 server(可选;未实现则首次查询时冷启动)。 */
  warmup?(): Promise<readonly string[]>;
}
