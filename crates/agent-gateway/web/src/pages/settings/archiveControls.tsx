import type { ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";

export function archiveSourceLabel(id: string, t: (key: string) => string, displayName?: string) {
  if (displayName?.trim()) return displayName;
  const key = `archive.source.${id}`;
  const translated = t(key);
  return translated === key ? id : translated;
}

export function ArchiveSelect(props: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
  icon?: ReactNode;
  id?: string;
}) {
  return (
    <Select value={props.value} onValueChange={props.onChange} disabled={props.disabled}>
      <SelectTrigger id={props.id} aria-label={props.label} className="h-9 rounded-xl border-border/70 text-xs shadow-none">
        <span className="flex min-w-0 items-center gap-2">
          {props.icon}
          <SelectValue>
            <span className="truncate">{props.options.find((item) => item.value === props.value)?.label ?? props.value}</span>
          </SelectValue>
        </span>
      </SelectTrigger>
      <SelectContent>
        {props.options.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
