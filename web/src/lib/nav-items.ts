import {
  LayoutDashboard,
  Compass,
  ListChecks,
  Radar,
  BarChart3,
  FileText,
  Settings,
  UserRound,
  BriefcaseBusiness,
  ClipboardCheck,
  Layers3,
  MessageSquareText,
  Handshake,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";

// Single source of truth for the app's primary destinations — shared by the
// desktop sidebar and the mobile nav so they can never drift.
export type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  chip?: string;
};

export const PRIMARY_NAV_ITEMS: NavItem[] = [
  { href: "/campaigns", label: "多岗位 Campaign", icon: Layers3 },
  { href: "/", label: "今日待办", icon: LayoutDashboard },
  { href: "/profile", label: "个人事实与证据", icon: UserRound },
  { href: "/cv", label: "主简历和岗位简历", icon: FileText },
  { href: "/job-analysis", label: "岗位导入与资格分析", icon: BriefcaseBusiness },
  { href: "/application-materials", label: "网申材料", icon: ClipboardCheck },
  { href: "/interview-center", label: "项目面试特训", icon: MessageSquareText },
  { href: "/pipeline", label: "申请进度", icon: ListChecks },
];

export const ADVANCED_NAV_ITEMS: NavItem[] = [
  { href: "/explore", label: "海外职位发现", icon: Compass, chip: "高级" },
  { href: "/portals", label: "海外招聘门户", icon: Radar, chip: "高级" },
  { href: "/analytics", label: "数据分析", icon: BarChart3, chip: "高级" },
  { href: "/config", label: "系统配置", icon: Settings },
];

export const PLANNED_NAV_ITEMS: NavItem[] = [
  { href: "/offer-onboarding", label: "Offer 与入职", icon: Handshake, chip: "V5 预留" },
];

export const NAV_ITEMS: NavItem[] = [...PRIMARY_NAV_ITEMS, ...PLANNED_NAV_ITEMS, ...ADVANCED_NAV_ITEMS];

export function isActivePath(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
