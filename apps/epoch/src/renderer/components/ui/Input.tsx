import * as React from 'react';
import { cn } from '../../libs/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Red focus ring + aria-invalid. Pairs with FieldError below rather than owning its own message. */
  invalid?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, invalid, ...props }, ref) => (
  <input
    ref={ref}
    aria-invalid={invalid || undefined}
    className={cn(
      'w-full bg-background rounded-lg px-3 py-2 text-data text-foreground placeholder:text-muted-foreground/60 border transition-colors focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed',
      invalid ? 'border-danger focus:border-danger' : 'border-border focus:border-accent',
      className
    )}
    {...props}
  />
));
Input.displayName = 'Input';
