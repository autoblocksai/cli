export type Handler = () => void;
export type AsyncHandler = () => Promise<void>;
export type HandlerOf<T> = (val: T) => void;
export type AsyncHandlerOf<T> = (val: T) => Promise<void>;
