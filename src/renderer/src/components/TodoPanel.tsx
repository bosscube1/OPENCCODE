import { useState } from 'react'
import type { ReactNode } from 'react'
import { useStore } from '../lib/store'

export function TodoPanel(): ReactNode {
  const todos = useStore((state) => state.todos)
  const [collapsed, setCollapsed] = useState(false)

  if (!todos || todos.length === 0) {
    return null
  }

  const completedCount = todos.filter((t) => t.status === 'completed').length
  const totalCount = todos.length

  return (
    <div className="todo-panel">
      <button
        type="button"
        className="todo-panel__header"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="todo-panel__title">Tasks ({completedCount}/{totalCount} completed)</span>
        <span className="todo-panel__toggle" aria-hidden="true">
          {collapsed ? 'v' : '^'}
        </span>
      </button>
      {!collapsed ? (
        <ul className="todo-panel__list">
          {todos.map((todo) => {
            let icon = '○'
            let iconClass = 'todo__icon'
            let itemClass = 'todo__item'

            if (todo.status === 'completed') {
              icon = '●'
              iconClass += ' todo__icon--completed'
              itemClass += ' todo__item--completed'
            } else if (todo.status === 'in_progress') {
              icon = '◔'
              iconClass += ' todo__pulsing'
              itemClass += ' todo__item--progress'
            } else if (todo.status === 'cancelled') {
              icon = '✕'
              iconClass += ' todo__icon--cancelled'
              itemClass += ' todo__item--cancelled'
            } else {
              iconClass += ' todo__icon--pending'
              itemClass += ' todo__item--pending'
            }

            return (
              <li key={todo.id} className={itemClass}>
                <span className={iconClass} aria-hidden="true">{icon}</span>
                <span className="todo__desc">{todo.content}</span>
                {todo.priority ? (
                  <span className={`todo__badge todo__badge--${todo.priority}`}>
                    {todo.priority}
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
