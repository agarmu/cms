export interface Page {
    limit: number;
    offset: number;
}

export type Changes<T> = { [Key in keyof Omit<T, "id">]?: T[Key] | undefined };
