import { useRef } from 'react'

interface FormattedPriceInputProps {
  value: string | number | null | undefined
  onChange: (rawValue: string) => void
  placeholder?: string
  required?: boolean
  disabled?: boolean
  className?: string
  id?: string
  name?: string
  autoFocus?: boolean
}

export default function FormattedPriceInput({
  value,
  onChange,
  placeholder = '0',
  required,
  disabled,
  className = '',
  id,
  name,
  autoFocus,
}: FormattedPriceInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  // Convert incoming full IDR value to thousands display
  let display = ''
  if (value !== '' && value !== null && value !== undefined) {
    const num = typeof value === 'number' ? value : Number(value)
    if (!isNaN(num)) {
      if (num === 0) {
        display = '0'
      } else {
        const thousands = Math.round(num / 1000)
        display = thousands.toLocaleString('id-ID')
      }
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
    const inputVal = e.target.value
    const digitsOnly = inputVal.replace(/\D/g, '')
    const cursor = e.target.selectionStart ?? 0
    const digitsBeforeCursor = (inputVal.slice(0, cursor).match(/\d/g) || []).length

    if (!digitsOnly) {
      onChange('')
    } else {
      const thousandsNumber = parseInt(digitsOnly, 10)
      if (isNaN(thousandsNumber)) {
        onChange('')
      } else if (thousandsNumber === 0) {
        onChange('0')
      } else {
        onChange(String(thousandsNumber * 1000))
      }
    }

    requestAnimationFrame(() => {
      if (inputRef.current) {
        const fv = inputRef.current.value
        let pos = 0
        let digitsSeen = 0
        for (let i = 0; i < fv.length && digitsSeen < digitsBeforeCursor; i++) {
          if (/\d/.test(fv[i])) digitsSeen++
          pos = i + 1
        }
        if (digitsBeforeCursor >= digitsOnly.length || digitsOnly.length === 0) pos = fv.length
        inputRef.current.setSelectionRange(pos, pos)
      }
    })
  }

  return (
    <div className="relative flex items-center">
      <span className="pointer-events-none absolute left-2.5 select-none text-xs font-medium text-gray-500">
        Rp
      </span>
      <input
        ref={inputRef}
        id={id}
        name={name}
        type="text"
        inputMode="numeric"
        value={display}
        onChange={handleInput}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        autoFocus={autoFocus}
        className={`w-full rounded-md border border-gray-300 py-2 pl-8 pr-11 text-sm focus:border-gray-500 focus:outline-none disabled:bg-gray-100 ${className}`}
      />
      <span className="pointer-events-none absolute right-2.5 select-none text-xs font-medium text-gray-400">
        .000
      </span>
    </div>
  )
}
