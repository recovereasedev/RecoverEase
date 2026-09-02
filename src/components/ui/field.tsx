import { AlertCircle } from 'lucide-react'
import {
  createContext,
  useContext,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'

import { cn } from '@/lib/utils'

/**
 * Form field primitives.
 *
 * Three accessibility rules are enforced structurally here rather than left
 * to each form to remember:
 *
 *  1. Labels are always visible. A placeholder is not a label — it disappears
 *     the moment someone types, which is exactly when a user filling in a
 *     long medical form needs to check what a field was asking for.
 *  2. The error message sits next to its field, not in a summary at the top,
 *     and is wired to the input with `aria-describedby` so a screen reader
 *     reads it as part of the field.
 *  3. Invalid fields carry `aria-invalid`, so the error is conveyed by more
 *     than a red border.
 */

type FieldContextValue = {
  inputId: string
  descriptionId: string
  errorId: string
  hasError: boolean
  hasDescription: boolean
}

const FieldContext = createContext<FieldContextValue | null>(null)

function useFieldContext(component: string): FieldContextValue {
  const context = useContext(FieldContext)
  if (!context) {
    throw new Error(`<${component}> must be rendered inside a <Field>.`)
  }
  return context
}

export type FieldProps = {
  label: string
  /** Helper text shown under the label, before the control. */
  description?: string
  error?: string | undefined
  required?: boolean
  className?: string
  children: ReactNode
}

export function Field({
  label,
  description,
  error,
  required = false,
  className,
  children,
}: FieldProps) {
  const id = useId()
  const value: FieldContextValue = {
    inputId: `${id}-input`,
    descriptionId: `${id}-description`,
    errorId: `${id}-error`,
    hasError: Boolean(error),
    hasDescription: Boolean(description),
  }

  return (
    <FieldContext.Provider value={value}>
      <div className={cn('space-y-1.5', className)}>
        <label
          htmlFor={value.inputId}
          className="block text-sm font-medium text-heading"
        >
          {label}
          {required ? (
            <>
              <span aria-hidden="true" className="ml-0.5 text-danger-700">
                *
              </span>
              <span className="sr-only"> (required)</span>
            </>
          ) : null}
        </label>

        {description ? (
          <p id={value.descriptionId} className="text-sm text-muted">
            {description}
          </p>
        ) : null}

        {children}

        {error ? (
          // role="alert" so the message is announced when it appears after a
          // failed submit, not only when the field is focused.
          <p
            id={value.errorId}
            role="alert"
            className="flex items-start gap-1.5 text-sm font-medium text-danger-700"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {error}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  )
}

const controlClasses = [
  'block w-full rounded-[var(--radius-md)] bg-surface',
  'border border-[var(--color-border-strong)]',
  'px-3 text-base text-heading placeholder:text-neutral-400',
  'transition-colors duration-[var(--duration-fast)]',
  'hover:border-neutral-400',
  'disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-muted',
  'aria-[invalid=true]:border-danger-700',
].join(' ')

function describedBy(context: FieldContextValue): string | undefined {
  const ids = [
    context.hasDescription ? context.descriptionId : null,
    context.hasError ? context.errorId : null,
  ].filter(Boolean)

  return ids.length > 0 ? ids.join(' ') : undefined
}

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  const context = useFieldContext('Input')

  return (
    <input
      id={context.inputId}
      aria-invalid={context.hasError || undefined}
      aria-describedby={describedBy(context)}
      className={cn(controlClasses, 'h-11', className)}
      {...props}
    />
  )
}

export function Textarea({
  className,
  rows = 4,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const context = useFieldContext('Textarea')

  return (
    <textarea
      id={context.inputId}
      rows={rows}
      aria-invalid={context.hasError || undefined}
      aria-describedby={describedBy(context)}
      className={cn(controlClasses, 'py-2.5 leading-relaxed', className)}
      {...props}
    />
  )
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const context = useFieldContext('Select')

  return (
    <select
      id={context.inputId}
      aria-invalid={context.hasError || undefined}
      aria-describedby={describedBy(context)}
      className={cn(controlClasses, 'h-11', className)}
      {...props}
    >
      {children}
    </select>
  )
}
