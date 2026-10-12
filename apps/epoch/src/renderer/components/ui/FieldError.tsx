export function FieldError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return <p className="text-2xs text-danger mt-1 font-medium">{children}</p>;
}
