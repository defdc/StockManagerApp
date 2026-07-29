import type { ReactNode } from 'react'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}

export default function Modal({ title, onClose, children, wide }: ModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-3 sm:p-4 sm:items-center">
      <div className={`w-full max-w-[calc(100vw-1.5rem)] ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'} rounded-lg bg-white shadow-lg my-auto`}>
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="max-h-[82vh] overflow-y-auto p-3 sm:p-4">{children}</div>
      </div>
    </div>
  )
}
