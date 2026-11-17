import * as React from 'react'
import * as ProgressPrimitive from '@radix-ui/react-progress'
import { cn } from '@/platform/lib/utils'

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    // Radix only renders aria-valuenow/aria-valuetext when it is given the
    // value; without it every bar in the app announced as indeterminate.
    value={value ?? null}
    className={cn(
      'relative h-2 w-full overflow-hidden rounded-full bg-muted',
      className
    )}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className="progress-sheen h-full w-full flex-1 bg-primary transition-all"
      style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
    />
  </ProgressPrimitive.Root>
))
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
