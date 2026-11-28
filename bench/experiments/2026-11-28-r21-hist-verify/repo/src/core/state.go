package core

type State struct {
	Name  string
	Count int
}

func (s *State) Increment() {
	s.Count = s.Count + 1
}
