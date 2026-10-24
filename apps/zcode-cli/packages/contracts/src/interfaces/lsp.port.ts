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

export interface LspPort {
  /** 已配置 server 的语言 id 清单(注册门的判据;空数组=功能整体不注册)。 */
  availableLanguages(): readonly string[];
  definition(request: LspDefinitionRequest): Promise<LspLocation[]>;
}
