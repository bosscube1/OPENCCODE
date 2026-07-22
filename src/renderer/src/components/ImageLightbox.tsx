import { useCallback, useEffect } from 'react'
import type { ReactNode } from 'react'

export interface ImageLightboxProps {
  src: string
  alt?: string
  onClose: () => void
}

/**
 * Full-screen overlay lightbox for viewing images.
 * Click on backdrop or press Escape to close.
 */
export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps): ReactNode {
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) {
        onClose()
      }
    },
    [onClose]
  )

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="lightbox" onClick={handleBackdropClick}>
      <img className="lightbox__img" src={src} alt={alt || 'Full size image'} />
    </div>
  )
}
