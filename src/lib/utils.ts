import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDueTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return date.toLocaleString(undefined, {
    weekday: sameDay ? undefined : "short",
    hour: "2-digit",
    minute: "2-digit",
    month: sameDay ? undefined : "short",
    day: sameDay ? undefined : "numeric",
  });
}
