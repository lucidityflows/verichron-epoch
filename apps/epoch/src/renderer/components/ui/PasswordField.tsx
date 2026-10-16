import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '../../libs/utils';
import { Input, type InputProps } from './Input';

export type PasswordFieldProps = Omit<InputProps, 'type'>;

export const PasswordField = React.forwardRef<HTMLInputElement, PasswordFieldProps>(
  ({ autoComplete = 'new-password', className, ...props }, ref) => {
    const [visible, setVisible] = React.useState(false);
    return (
      <div className="relative">
        <Input
          ref={ref}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          className={cn('pr-9', className)}
          {...props}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
        >
          {visible ? <EyeOff size="0.875rem" /> : <Eye size="0.875rem" />}
        </button>
      </div>
    );
  }
);
PasswordField.displayName = 'PasswordField';
