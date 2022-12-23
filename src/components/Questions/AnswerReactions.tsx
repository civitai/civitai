type AnswerReactionProps = {
  counts: {
    heart?: number;
    check?: number;
    cross?: number;
  };
  userReaction: {
    id: number;
    userId: number;
    heart?: Date | null;
    check?: Date | null;
    cross?: Date | null;
  };
} & z.infer<typeof getReactionSchema>;

export function AnswerReactions() {}
