export default function ArcReactor({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={className} aria-hidden>
      <circle
        cx="32"
        cy="32"
        r="27"
        fill="none"
        stroke="hsl(186 100% 45%)"
        strokeWidth="1.5"
        strokeDasharray="6 5"
        className="origin-center animate-sweep opacity-70"
      />
      <circle cx="32" cy="32" r="20" fill="none" stroke="hsl(199 80% 42%)" strokeWidth="2" opacity="0.85" />
      <circle
        cx="32"
        cy="32"
        r="12"
        fill="none"
        stroke="hsl(186 100% 45%)"
        strokeWidth="1.5"
        strokeDasharray="3 4"
        className="origin-center animate-sweep"
        style={{ animationDirection: "reverse", animationDuration: "14s" }}
      />
      <circle cx="32" cy="32" r="5" fill="hsl(186 100% 45%)" className="animate-pulse-glow" />
    </svg>
  );
}
