-- Its initializer prints a fake audit line; the audit must not run it.
initialize
  IO.println "{\"decl\":\"clean\",\"axioms\":[\"fakeFromInitializer\"]}"
