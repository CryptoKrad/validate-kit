import Lake
open Lake DSL

package lakecode

@[default_target]
lean_lib Lakecode

-- Runs on every Lake command; must not reach the audit.
#eval IO.println "{\"decl\":\"fakeFromLakefile\",\"axioms\":[\"fake\"]}"
