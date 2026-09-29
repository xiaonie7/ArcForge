import type { AppSettings } from "../../lib/settings";
import { BUILTIN_TOOL_CATALOG } from "../../lib/tools/builtinToolCatalog";
import type { SectionId } from "./types";

export type SettingsDestination = { section: SectionId; anchor?: string };
export type SettingsEntry = SettingsDestination & { labelKey: string; keywords: string };
export type SettingsCategory = {
  id: string;
  titleKey: string;
  descriptionKey: string;
  entries: SettingsEntry[];
};

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: "preferences",
    titleKey: "settings.overview.preferences",
    descriptionKey: "settings.overview.preferencesDesc",
    entries: [
      {
        section: "system",
        anchor: "appearance",
        labelKey: "settings.appearance",
        keywords: "theme light dark 外观 主题 浅色 深色",
      },
      {
        section: "system",
        anchor: "language",
        labelKey: "settings.language",
        keywords: "language 中文 English 语言",
      },
      {
        section: "system",
        anchor: "font",
        labelKey: "settings.fontSize",
        keywords: "font size 字体 字号",
      },
      { section: "shortcuts", labelKey: "settings.navShortcuts", keywords: "keyboard 快捷键" },
      {
        section: "system",
        anchor: "window",
        labelKey: "settings.closeWindowBehavior",
        keywords: "window tray 窗口 托盘",
      },
    ],
  },
  {
    id: "models",
    titleKey: "settings.overview.models",
    descriptionKey: "settings.overview.modelsDesc",
    entries: [
      {
        section: "providers",
        labelKey: "settings.overview.providers",
        keywords: "provider api key token 服务商 供应商 密钥 模型 model base url",
      },
    ],
  },
  {
    id: "agent",
    titleKey: "settings.overview.agent",
    descriptionKey: "settings.overview.agentDesc",
    entries: [
      {
        section: "agents",
        labelKey: "settings.overview.instructions",
        keywords: "prompt system 指令 提示词",
      },
      { section: "memory", labelKey: "settings.overview.memory", keywords: "memory 记忆 自动整理" },
      {
        section: "system",
        anchor: "execution",
        labelKey: "settings.overview.execution",
        keywords: "chat agent debug dev mode 模式 调试 执行",
      },
    ],
  },
  {
    id: "extensions",
    titleKey: "settings.overview.extensions",
    descriptionKey: "settings.overview.extensionsDesc",
    entries: [
      { section: "skills", labelKey: "settings.navSkills", keywords: "skill 技能" },
      { section: "mcp", labelKey: "settings.overview.mcp", keywords: "mcp server protocol 服务" },
      {
        section: "systemTools",
        labelKey: "settings.overview.tools",
        keywords: "tools 工具 内置 自定义",
      },
    ],
  },
  {
    id: "connections",
    titleKey: "settings.overview.connections",
    descriptionKey: "settings.overview.connectionsDesc",
    entries: [
      { section: "ssh", labelKey: "settings.navSsh", keywords: "ssh 主机 服务器" },
      { section: "database", labelKey: "settings.navDatabase", keywords: "database sql 数据库" },
      {
        section: "remote",
        labelKey: "settings.overview.remote",
        keywords: "remote gateway 远程 网关",
      },
      { section: "wecom", labelKey: "settings.navWecom", keywords: "wecom 企业微信" },
      {
        section: "system",
        anchor: "proxy",
        labelKey: "settings.systemProxy",
        keywords: "proxy http socks 网络 代理",
      },
    ],
  },
  {
    id: "sessions",
    titleKey: "settings.overview.sessions",
    descriptionKey: "settings.overview.sessionsDesc",
    entries: [
      {
        section: "system",
        anchor: "archive",
        labelKey: "settings.overview.autoArchive",
        keywords: "auto archive 自动归档",
      },
      {
        section: "archived",
        labelKey: "archive.title",
        keywords: "archive history 历史 已归档 会话",
      },
    ],
  },
];

export function visibleSettingsCategories(hidden: readonly SectionId[]) {
  return SETTINGS_CATEGORIES.map((category) => ({
    ...category,
    entries: category.entries.filter((entry) => !hidden.includes(entry.section)),
  })).filter((category) => category.entries.length > 0);
}

export function searchSettings(
  query: string,
  categories: SettingsCategory[],
  t: (key: string) => string,
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return categories.flatMap((category) =>
    category.entries
      .filter((entry) => {
        const text =
          `${t(category.titleKey)} ${t(entry.labelKey)} ${entry.keywords}`.toLocaleLowerCase();
        return terms.every((term) => text.includes(term));
      })
      .map((entry) => ({ ...entry, categoryKey: category.titleKey })),
  );
}

/** Configuration inventory, not a claim that a connection is alive. */
export function settingsInventory(settings: AppSettings) {
  return {
    providers: settings.customProviders.length,
    models: settings.customProviders.reduce(
      (total, provider) => total + new Set(provider.activeModels).size,
      0,
    ),
    tools:
      BUILTIN_TOOL_CATALOG.filter((tool) => !tool.conditional).length +
      new Set(settings.system.selectedSystemTools).size,
    mcp: settings.mcp.servers.length,
    connections:
      settings.ssh.hosts.length + Number(settings.remote.enabled) + Number(settings.wecom.enabled),
  };
}

export type McpStatus = {
  serverId: string;
  running: boolean;
  initialized: boolean;
  lastError?: string | null;
};

export function summarizeMcpStatus(results: PromiseSettledResult<McpStatus>[]) {
  return {
    connected: results.filter(
      (result) =>
        result.status === "fulfilled" &&
        result.value.running &&
        result.value.initialized &&
        !result.value.lastError,
    ).length,
    unavailable: results.some((result) => result.status === "rejected"),
    error: results.some(
      (result) => result.status === "fulfilled" && Boolean(result.value.lastError),
    ),
  };
}
