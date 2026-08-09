import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import type { DMAnswers, DMQuestion } from '@/types'

type Props = {
  open: boolean
  questions: DMQuestion[]
  initialAnswers?: DMAnswers
  onSubmit: (answers: DMAnswers) => void
  onSkip: () => void
}

export function DMQuestionsModal({ open, questions, initialAnswers, onSubmit, onSkip }: Props) {
  const [answers, setAnswers] = useState<DMAnswers>(initialAnswers ?? {})

  useEffect(() => {
    if (open) setAnswers(initialAnswers ?? {})
  }, [open, initialAnswers])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onSkip() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dungeon Master clarifications</DialogTitle>
          <DialogDescription>
            The audit pass surfaced {questions.length} question
            {questions.length === 1 ? '' : 's'} about ambiguous moments. Answer what you can —
            unanswered ones will be skipped.
          </DialogDescription>
        </DialogHeader>

        {questions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No questions surfaced. You can continue straight to the chronicle.
          </p>
        ) : (
          <div className="space-y-4">
            {questions.map((q, i) => (
              <div key={q.id} className="space-y-2 border-l-2 border-primary/30 pl-3">
                <Label htmlFor={q.id} className="text-sm">
                  <span className="text-muted-foreground mr-2">{i + 1}.</span>
                  {q.question}
                </Label>
                {q.context && (
                  <p className="text-xs italic text-muted-foreground">
                    "{q.context}"
                  </p>
                )}
                <Textarea
                  id={q.id}
                  rows={2}
                  value={answers[q.id] ?? ''}
                  onChange={(e) =>
                    setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                  }
                  placeholder="Your answer (or leave blank to skip)"
                />
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onSkip}>
            Skip all
          </Button>
          <Button onClick={() => onSubmit(answers)}>Continue to chronicle</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
