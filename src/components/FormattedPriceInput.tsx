import { useRef } from 'react'

interface FormattedPriceInputProps {
  value: string
  onChange: (rawValue: string) => void
  placeholder?: string
  required?: boolean
  disabled?: boolean
  className?: string
}

export default function FormattedPriceInput({
  value,
  onChange,
  placeholder = '0',
  required,
  disabled,
  className = '',
}: FormattedPriceInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  const display = value ? parseInt(value, 10).toLocaleString('id-ID') : ''

  function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value.replace(/\D/g, '')
    const cursor = e.target.selectionStart ?? 0
    const digitsBeforeCursor = (e.target.value.slice(0, cursor).match(/\d/g) || []).length

    onChange(raw)

    requestAnimationFrame(() => {
      if (inputRef.current) {
        const fv = inputRef.current.value
        let pos = 0
        let digitsSeen = 0
        for (let i = 0; i < fv.length && digitsSeen < digitsBeforeCursor; i++) {
          if (/\d/.test(fv[i])) digitsSeen++
          pos = i + 1
        }
        if (digitsBeforeCursor >= raw.length || raw.length === 0) pos = fv.length
        inputRef.current.setSelectionRange(pos, pos)
      }
    })
  }

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 select-none text-sm font-medium text-gray-500">
        Rp
      </span>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        value={display}
        onChange={handleInput}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        className={`w-full rounded-md border border-gray-300 px-3 py-2 pl-10 text-sm focus:border-gray-500 focus:outline-none disabled:bg-gray-100 ${className}`}
      />
    </div>
  )
}
